# Polaris CLI Player

A macOS CLI music player for the Polaris music library.

## Dependencies

- [mpv](https://mpv.io/) — `brew install mpv`
- Node.js (v18+) — bundled with macOS or `brew install node`

## Setup

```bash
# Link to PATH (one-time)
ln -sf ~/code/polaris/cli/player/player.sh /usr/local/bin/player
```

## Usage

### Playback

```bash
# Play a song (search by name, supports simplified↔traditional Chinese)
player play 消愁
player play "Bohemian Rhapsody Queen"

# Control
player pause / resume / toggle / stop
player next / prev

# Navigation
player seek +10
player seek -30

# Volume
player volume 60
```

### Queue

```bash
player list              # Show queued tracks
player queue "漠河舞厅"  # Add to queue
player shuffle            # Randomize queue order
```

### Playlist (Polaris API)

```bash
player playlist           # Load "fav" playlist (650 tracks) from Polaris
player playlist mylist    # Load a specific playlist
player shuffle            # Shuffle after loading
player pl-add 消愁        # Add to current playlist
player pl-remove 消愁     # Remove from current playlist
```

### Info & Search

```bash
player status / now      # Current playback info
player search 陈奕迅     # Search library (fuzzy match, simptrad support)
player help
```

## How It Works

- **Audio backend**: `mpv --no-video` running as daemon, controlled via Unix IPC socket
- **Music source**: `~/Music/polaris/` (Artist/Album/ structure, mirrored from JDC)
- **Playlist source**: Polaris server at `http://192.168.100.1:5050`
- **Cover art**: Downloaded from Polaris thumbnail API, pushed via mpv `cover-art-files`
- **State**: Everything from mpv IPC or Polaris API — no local state cache
- **Logging**: All operations logged to `/tmp/polaris-player/player.log` (auto-rotate at 5MB)
- **Format support**: mp3, m4a, flac, wav, ogg
