# Vox Music System — Cover Art Architecture

## Problem

macOS NowPlaying cover always lagged by 1 track. When user skipped to the next song,
mpv displayed the **previous** song's cover instead of the current one.

## Root Cause

`cover-art-files` is read by mpv **at file-load time**. The old Node.js watcher responded to
`property-change "path"`, which fires **after** mpv has already read `cover-art-files`.
By the time the watcher downloaded the cover and set the property, it was too late.

```text
Timeline:
  skip → mpv sets path property → mpv reads cover-art-files (OLD value) → property-change fires
  → watcher downloads cover → watcher sets cover-art-files → ❌ too late
```

## Why Manual IPC Worked

`cover-art-files` is **sticky** — it survives across file loads. When the user manually
sent `set cover-art-files /tmp/cover.jpg` while the previous song was still playing,
mpv loaded the new file and displayed `/tmp/cover.jpg` (the sticky old value). The
hook then replaced it with the correct cover. It "worked" because the old cover happened
to be for the new track only if the command was sent ahead of time.

## Solution: Mpv Lua `on_load` Hook

mpv provides a hook system that **pauses file loading** until the hook completes.
Hook `on_load` fires before the demuxer opens the file — the perfect moment to set
`cover-art-files`.

```text
Timeline (fixed):
  skip → on_load hook fires (PAUSES loading) → Lua downloads cover → sets cover-art-files
  → hook returns (auto-ack) → mpv continues loading → reads correct cover → ✅
```

### Implementation

**`cli/voxctl/cover-hook.lua`** — mpv Lua script loaded via `--script`

- Registers `on_load` hook at priority 0 (highest)
- Hook blocks (synchronous) — mpv waits until the function returns
- Auth with Vox API via `curl` → download thumbnail → save to `/tmp/vox-player/`
- Set `cover-art-files` via `mp.set_property()`
- Return → mpv reads `cover-art-files` → correct NowPlaying cover
- Also writes all logs to `/tmp/vox-player/player.log` (track changes, cover status, errors)

### Files

| File                         | Role                                                      |
|------------------------------|-----------------------------------------------------------|
| `cli/voxctl/cover-hook.lua`  | **Lua script** — hook + download + set cover + write logs |
| `cli/voxctl/player.js`       | Starts mpv with `--script=cover-hook.lua` (line 189)      |
| `docs/cover-architecture.md` | This document                                             |

`voxctl-cover-watcher.js` was removed — logging is now inline in `cover-hook.lua`.

### Key Insights

1. **`hook_add` is not available via IPC** in mpv 0.41.0 — Lua scripting is required
2. **Lua hooks auto-ack** when the function returns (no explicit `hook_ack` needed)
3. **Cover download is synchronous** — `os.execute("curl ...")` + `io.popen` blocks the hook
4. **This is the correct approach**: the hook runs at the earliest possible moment, before
   any file data is read

### Debugging

If covers are still wrong, check:

1. `/tmp/vox-player/player.log` — track change and cover status logs
2. `echo '{"command": ["get_property", "cover-art-files"]}' | nc -U ~/.vox/player/mpv.sock`

### Log Format

```text
[2026-06-12 18:15:19] [INFO  ] Cover hook registered (on_load)
[2026-06-12 18:15:26] [INFO  ] ────────────────────────────────────────
[2026-06-12 18:15:26] [INFO  ] Track path changed  <url>
[2026-06-12 18:15:26] [INFO  ] Cover set (cache)  /tmp/vox-player/cover-xxx.jpg
[2026-06-12 18:15:26] [INFO  ] music playing
```

No separate watcher process needed — all logging is done inside the Lua hook.
