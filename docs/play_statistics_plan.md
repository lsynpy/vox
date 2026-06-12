# Play Statistics Implementation Plan

## Overview

Add play tracking and statistics to Vox, enabling features like:

- Recently played artists/albums/songs
- Most played content
- Play count tracking
- Listening history

**All statistics are strictly per-user.** Each user's listening data is isolated and cannot be accessed by other users.

This makes Vox self-sufficient without needing external services like Last.fm.

---

## Architecture Decisions

### Storage Choice: Native_db

**Rationale:**

- Already integrated into Vox for playlist storage
- Supports per-user data with secondary keys (filter by owner)
- ACID transactions with read/write separation
- Schema versioning support for future migrations
- No additional dependencies needed

**Alternative considered:** Adding to `collection.index`

- Rejected: Binary serialized snapshot, not designed for frequent writes
- Play data needs frequent updates (every song play)
- Per-user data doesn't belong in shared collection index

---

## Data Model

### 1. Play Record (Native_db Model)

**One record created when a song finishes playing (full plays only).**

```rust
#[native_model(id = 2, version = 1)]
#[native_db(primary_key(play_id -> String))]
pub struct PlayRecord {
    #[secondary_key]
    pub username: String,           // Who played it
    pub play_id: String,            // UUID, prevents duplicates
    pub song_path: PathBuf,         // Which song (virtual path)
    pub artist_names: Vec<String>,  // Denormalized for queries without joining collection
    pub album_name: String,         // Denormalized album name
    pub album_artists: Vec<String>, // Denormalized album artists
    pub played_at: SystemTime,      // When it finished
}
```

**Design notes:**

- `play_id` as primary key (String) - simple, avoids composite key complexity
- `username` as secondary key - enables "all plays by user X" queries
- Denormalized artist/album data - avoids cross-referencing collection which may change
- **No `completed` field** - implicit (only recorded on finish)
- **No `duration_played` field** - can be looked up from collection if needed
- **No pre-computed aggregates** - compute on demand from raw records (see Performance section)
- Fields removed to save space; can be added later if skip tracking is needed

### Data Volume (<10K Tracks)

| Metric                         | Estimate   |
|--------------------------------|------------|
| Unique artists                 | ~500-2,000 |
| Plays per user per day         | 50-200     |
| Play records per year          | 18k-73k    |
| Records with 365-day retention | <50k       |
| Storage (1 year)               | ~15 MB     |

---

## Implementation Phases

### Phase 1: Core Infrastructure

#### 1.1 Create Play Statistics Module

**File:** `server/src/app/play_stats.rs`

```text
Structure:
├── PlayRecord model (native_db definition)
├── Manager struct with methods:
│   ├── record_play(username, song_path, metadata) -> Result<()>
│   ├── get_recent_plays(username, limit, offset) -> Vec<PlayRecord>
│   ├── get_artist_stats(username) -> Vec<ArtistStats>
│   ├── get_song_play_count(username, song_path) -> u32
│   └── cleanup_removed_song(song_path) -> Result<()>
└── Tests
```

**Key methods:**

```rust
pub struct Manager {
    ndb: ndb::Manager,
    // Reference to index manager for resolving song metadata
    index: index::Manager,
}

impl Manager {
    // Record a play when a song finishes
    pub async fn record_play(&self, username: &str, song_path: &Path) -> Result<(), Error>;

    // Get recent plays for UI "Recently Played" lists
    pub async fn get_recent_plays(&self, username: &str, limit: usize) -> Result<Vec<PlaySummary>, Error>;

    // Get play counts for sorting (computed on demand, no aggregates)
    pub async fn get_artist_play_counts(&self, username: &str) -> Result<Vec<ArtistPlayCount>, Error>;

    // Get recently played artists for sorting (computed on demand)
    pub async fn get_artist_recently_played(&self, username: &str) -> Result<Vec<ArtistLastPlayed>, Error>;

    // Cleanup when song is removed from library
    pub async fn cleanup_removed_song(&self, song_path: &Path) -> Result<usize, Error>;

    // Cleanup old records based on retention policy
    pub async fn cleanup_old_records(&self, days_to_keep: u32) -> Result<usize, Error>;
}
```

**Query Implementation (no aggregates):**

```rust
// Artist play count - computed from raw records
pub async fn get_artist_play_counts(&self, username: &str) -> Result<Vec<ArtistPlayCount>, Error> {
    let records = self.ndb.r_transaction().get().secondary(PlayRecord::username, username)?;
    let mut map: HashMap<String, (u32, SystemTime)> = HashMap::new();

    for record in records {
        for artist in &record.artist_names {
            let entry = map.entry(artist.clone()).or_insert((0, record.played_at));
            entry.0 += 1;
            if record.played_at > entry.1 {
                entry.1 = record.played_at;
            }
        }
    }

    Ok(map.into_iter()
        .map(|(name, (count, last))| ArtistPlayCount {
            name, play_count: count, last_played: last,
        })
        .collect())
}
```

#### 1.2 Register Native_db Models

**File:** `server/src/app/ndb.rs`

Add new model to the `MODELS` static:

```rust
Models::builder()
    .define::<playlist::v1::PlaylistModel>()
    .define::<play_stats::PlayRecord>()          // NEW
    .build();
```

#### 1.3 Add Manager to App

**File:** `server/src/app.rs`

```rust
#[derive(Clone)]
pub struct App {
    // ... existing fields ...
    play_stats: play_stats::Manager,  // NEW
}
```

Update `FromRef` implementations for state extraction.

---

### Phase 2: API Endpoints

**Design: Backend Merge with `?sort=` Query Parameter**

Instead of creating separate `/play/...` endpoints, extend existing endpoints with a sort parameter. This reduces HTTP round trips and keeps the API clean.

#### 2.1 Extend Existing Endpoints

**File:** `server/src/server/axum/api.rs`

| Method | Path           | Sort Options                                                                  | Description                       |
|--------|----------------|-------------------------------------------------------------------------------|-----------------------------------|
| POST   | `/play/record` | -                                                                             | Record a song play (new endpoint) |
| GET    | `/api/artists` | `alpha` (default), `-alpha`, `popularity`, `-popularity`, `recent`, `-recent` | Existing endpoint, add sort param |
| GET    | `/api/albums`  | (future)                                                                      | (future)                          |

**Query parameter:**

```text
?sort=popularity   → order by play count DESC (most played first)
?sort=-popularity  → order by play count ASC (least played first)
?sort=recent       → order by last_played DESC (newest first)
?sort=-recent      → order by last_played ASC (oldest first)
?sort=alpha        → order by name ASC (A-Z, default)
?sort=-alpha       → order by name DESC (Z-A)
```

Prefix `-` reverses the sort direction.

**Example: Modified `get_artists` endpoint**

```rust
#[derive(Debug, Deserialize)]
struct ArtistQuery {
    sort: Option<String>,  // "alpha", "-alpha", "popularity", "-popularity", "recent", "-recent"
}

fn parse_sort(sort: &str) -> (&str, bool) {
    if sort.starts_with('-') {
        (&sort[1..], true)  // (field, descending)
    } else {
        (sort, false)
    }
}

#[utoipa::path(
    get,
    path = "/artists",
    tag = "Collection",
    params(ArtistQuery),
    security(
        ("auth_token" = []),
        ("auth_query_param" = []),
    ),
    responses(
        (status = 200, body = Vec<dto::ArtistHeader>),
    )
)]
async fn get_artists(
    auth: Auth,
    State(index_manager): State<index::Manager>,
    State(play_stats_manager): State<play_stats::Manager>,
    Query(query): Query<ArtistQuery>,
) -> Result<Json<Vec<dto::ArtistHeader>>, APIError> {
    let mut artists = index_manager
        .get_artists()
        .await
        .into_iter()
        .map(|a| a.into())
        .collect::<Vec<_>>();

    if let Some(ref sort_param) = query.sort {
        let (field, desc) = parse_sort(sort_param);

        match (field, desc) {
            ("popularity", desc) => {
                let stats = play_stats_manager
                    .get_artist_play_counts(auth.get_username())
                    .await?;
                let counts: HashMap<String, u32> = stats
                    .into_iter()
                    .map(|s| (s.name, s.play_count))
                    .collect();
                artists.sort_by(|a, b| {
                    let ca = counts.get(&a.name).copied().unwrap_or(0);
                    let cb = counts.get(&b.name).copied().unwrap_or(0);
                    if desc { cb.cmp(&ca) } else { ca.cmp(&cb) }
                        .then_with(|| a.name.cmp(&b.name))
                });
            }
            ("recent", desc) => {
                let stats = play_stats_manager
                    .get_artist_recently_played(auth.get_username())
                    .await?;
                let last_played: HashMap<String, SystemTime> = stats
                    .into_iter()
                    .map(|s| (s.name, s.last_played))
                    .collect();
                artists.sort_by(|a, b| {
                    let la = last_played.get(&a.name).copied().unwrap_or(UNIX_EPOCH);
                    let lb = last_played.get(&b.name).copied().unwrap_or(UNIX_EPOCH);
                    if desc { lb.cmp(&la) } else { la.cmp(&lb) }
                        .then_with(|| a.name.cmp(&b.name))
                });
            }
            ("alpha", desc) => {
                artists.sort_by(|a, b| {
                    if desc { b.name.cmp(&a.name) } else { a.name.cmp(&b.name) }
                });
            }
            _ => { /* invalid sort param, use default alpha */ }
        }
    }

    Ok(Json(artists))
}
```

#### 2.2 Record Play Endpoint

**New endpoint for recording plays:**

```rust
#[utoipa::path(
    post,
    path = "/play/record",
    tag = "Statistics",
    request_body = RecordPlayInput,
    responses((status = 200, body = RecordPlayOutput)),
)]
async fn record_play(
    auth: Auth,
    State(play_stats_manager): State<play_stats::Manager>,
    Json(input): Json<RecordPlayInput>,
) -> Result<Json<RecordPlayOutput>, APIError> {
    play_stats_manager.record_play(
        auth.get_username(),
        &input.song_path,
    ).await?;
    Ok(Json(RecordPlayOutput { success: true }))
}
```

#### 2.3 New DTOs

**File:** `server/src/server/dto/v8.rs`

```rust
#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct RecordPlayInput {
    pub song_path: PathBuf,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct PlaySummary {
    pub song_path: PathBuf,
    pub title: String,
    pub artists: Vec<String>,
    pub album: String,
    pub album_artists: Vec<String>,
    pub played_at: u64,  // Unix timestamp
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct ArtistPlayCount {
    pub name: String,
    pub play_count: u32,
    pub last_played: u64,  // Unix timestamp
}
```

#### 2.4 Register Routes

Add to `OpenApiRouter`:

```rust
// Existing route, now with sort param
.routes(routes!(get_artists))
// New route for recording plays
.routes(routes!(record_play))
```

---

### Phase 3: Frontend Integration

#### 3.1 Update API Client

**File:** `web/src/api/endpoints.ts`

Update `getArtists` to accept sort parameter with direction:

```typescript
export type ArtistSort = 'alpha' | '-alpha' | 'popularity' | '-popularity' | 'recent' | '-recent';

export async function getArtists(sort?: ArtistSort): Promise<ArtistHeader[]> {
    const params = sort ? `?sort=${sort}` : '';
    return api.get(`/artists${params}`);
}

export async function recordPlay(input: RecordPlayInput): Promise<RecordPlayOutput> {
    return api.post('/play/record', input);
}
```

#### 3.2 Update DTOs

**File:** `web/src/api/dto.ts`

```typescript
export interface RecordPlayInput {
    song_path: string;
}

export interface PlaySummary {
    song_path: string;
    title: string;
    artists: string[];
    album: string;
    album_artists: string[];
    played_at: number;
}

export interface ArtistPlayCount {
    name: string;
    play_count: number;
    last_played: number;
}
```

#### 3.3 Playback Store Integration

**File:** `web/src/stores/playback.ts`

Modify playback store to record plays when a song finishes:

```typescript
// When a song completes (fully played):
async function onSongComplete(song: Song) {
    await recordPlay({
        song_path: song.path,
    });
}
```

#### 3.4 Add Sort Options to Artists Page

**File:** `web/src/components/library/Artists.vue`

Add third sort option and fetch from backend with sort parameter:

```vue
<Switch v-model="sortBy" :items="[
    { icon: 'sort_by_alpha', value: 'alpha' },
    { icon: 'trending_up', value: 'popularity' },
    { icon: 'history', value: 'recent' }
]" />
```

Update data fetching to use backend sort:

```typescript
// When sort changes, re-fetch from backend
watch(sortBy, async (newSort) => {
    artists.value = await getArtists(newSort as any);
});
```

Remove client-side sorting logic (now handled by backend).

#### 3.5 Statistics Dashboard (Future)

**File:** `web/src/components/stats/StatsDashboard.vue` (new)

Potential features:

- Most played artists this week/month/all-time
- Listening activity heatmap
- Top songs
- Listening streaks

---

### Phase 4: Configuration & Maintenance

#### 4.1 Configuration Options

**File:** `server/src/app/config.rs`

Add optional config:

```rust
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct PlayStatsConfig {
    pub enabled: bool,                      // Master toggle
    pub retention_days: u32,                // Auto-cleanup old records (default: 365)
    pub track_duration: bool,               // Track how much of song was played
    pub min_completion_ratio: f32,          // Minimum % to count as "played" (default: 0.5)
}
```

#### 4.2 Background Cleanup Task

Add periodic cleanup in main.rs or scanner:

```rust
// Run daily/weekly
async fn cleanup_old_play_stats(&self) {
    let retention_days = self.config.get().play_stats.retention_days;
    let removed = self.play_stats.cleanup_old_records(retention_days).await?;
    log::info!("Cleaned up {} old play records", removed);
}
```

---

## Database Migration Strategy

Since native_db supports model versioning:

1. **Existing databases:** New models are simply added; existing `PlaylistModel` is unaffected
2. **Future changes:** Increment `version` in `#[native_model(id = X, version = Y)]`
3. **Migration code:** Add migration functions that read old format and write new format

---

## Performance Considerations

### Write Performance

- Recording a play is a single native_db write transaction (~1-5ms)
- Done asynchronously, won't block playback

### Read Performance (Backend Merge)

Query: `GET /api/artists?sort=popularity`

| Step      | Operation                           | Time         |
|-----------|-------------------------------------|--------------|
| 1         | Load artists from collection index  | ~5-10ms      |
| 2         | Load play records from native_db    | ~5-15ms      |
| 3         | Aggregate play counts (50k records) | ~10-30ms     |
| 4         | Sort 2000 artists                   | ~1ms         |
| **Total** |                                     | **~20-55ms** |

**Verdict:** ✅ Acceptable for our scale (<10k tracks, <50k play records)

### When to Optimize

| Play Records | Aggregation Time | Action                                    |
|--------------|------------------|-------------------------------------------|
| <50k         | <30ms            | ✅ No action needed                       |
| 50k-100k     | 30-80ms          | ✅ Still fine                             |
| >500k        | >200ms           | ⚠️ Add pre-computed aggregates or caching |

**Future optimization options:**

- Add secondary index on `(username, artist_name)` for faster grouping
- Maintain `ArtistPlayStats` aggregates (updated on each play)
- Cache results with TTL (e.g., 5 minutes)

### Storage Growth

- Each play record: ~150-250 bytes (paths, names, timestamp)
- 1000 songs/day × 365 days × 200 bytes ≈ 73 MB/year
- Mitigation: Configurable retention, periodic cleanup

---

## Testing Strategy

### Unit Tests

- Test play recording and retrieval
- Test aggregation logic
- Test cleanup functionality

### Integration Tests

- Test API endpoints with mock auth
- Test end-to-end: record play → query stats → verify sorting
- Test with large datasets (simulate months of plays)

### Test Data Location

- `server/test-data/` for fixture songs
- Generate synthetic play records for performance testing

---

## API Versioning

Current API version: **8.1** (as of v0.16.0)

**Options:**

1. **Minor bump** (8.1 → 8.2): Adding new endpoints is backward compatible
2. **Keep as 8.1.x**: If strictly additive with no breaking changes

**Recommendation:** Bump to 8.2 since these are new feature endpoints.

---

## Implementation Order

1. **Week 1:** Phase 1 - Core infrastructure
   - Create `play_stats.rs` module
   - Define native_db models
   - Implement Manager with basic CRUD
   - Unit tests

2. **Week 2:** Phase 2 - API endpoints
   - Define DTOs
   - Implement endpoints
   - Register routes
   - Integration tests

3. **Week 3:** Phase 3 - Frontend integration
   - Update API client and DTOs
   - Modify playback store to record plays
   - Add "recently played" sort option
   - Manual testing

4. **Week 4:** Phase 4 - Polish
   - Configuration options
   - Background cleanup
   - Documentation
   - Performance testing

---

## Edge Cases & Considerations

1. **Multi-user isolation:** Each user's plays are tracked separately via `username` field
2. **Anonymous users:** Not applicable - Vox requires auth
3. **Song path changes:** If library is rescanned and paths change, old play records may become orphaned
   - **Solution:** Clean up play records when scanner detects removed songs
4. **Concurrent plays:** If same user plays songs on multiple devices, records are independent
5. **Offline playback:** Web UI can queue plays locally and sync when reconnected (future enhancement)

---

## Files to Create/Modify

### New Files

```text
server/src/app/play_stats.rs           # Core module + models + manager
server/src/server/test/play_stats.rs  # Integration tests
```

### Modified Files

```text
server/src/app/ndb.rs                 # Register PlayRecord model
server/src/app.rs                     # Add play_stats manager to App
server/src/server/axum/api.rs         # Add ?sort= param to get_artists, add record_play endpoint
server/src/server/axum.rs             # (possibly) route setup changes
server/src/server/dto/v8.rs           # Add RecordPlayInput, RecordPlayOutput DTOs
web/src/api/endpoints.ts              # Update getArtists(sort), add recordPlay()
web/src/api/dto.ts                    # Add RecordPlayInput interface
web/src/stores/playback.ts            # Record plays when songs finish
web/src/components/library/Artists.vue # Add sort switch, use backend sort param
```

---

## Success Criteria

- ✅ Play records are reliably stored when songs finish playing
- ✅ `GET /api/artists?sort=popularity` returns artists ordered by play count
- ✅ `GET /api/artists?sort=recent` returns artists ordered by last played
- ✅ `GET /api/artists?sort=alpha` (default) returns artists A-Z
- ✅ Removed songs are cleaned from play records on library rescan
- ✅ Performance is acceptable (<60ms for stats queries with <50k records)
- ✅ Old data is automatically cleaned up based on retention policy
- ✅ No breaking changes to existing functionality
- ✅ Comprehensive test coverage (>80% for new code)
