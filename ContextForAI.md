# Vox - Context for AI

## Project Overview

**Vox** is a self-hosted music streaming server designed for exceptional performance with large
music collections (100,000+ songs). It is free, open-source software written in **Rust**.

### Key Characteristics

- **Type**: Music streaming server with web UI
- **Language**: Rust (edition 2021)
- **License**: MIT
- **Target Platforms**: Windows, Linux, BSD, Docker

### Core Features

- Support for multiple audio formats: flac, mp3, mp4, mpc, ogg, opus, ape, wav, aiff
- Multi-user support with playlists
- Dark mode themes with customizable color palette
- Song waveform visualization
- Multi-value metadata support (multiple artists per song, etc.)
- Powerful search with per-field queries
- Plain-text TOML configuration (editable via built-in UI)

### Architecture

- **Web Framework**: Axum (v0.8) with Tower HTTP middleware
- **Database**: native_db / native_model
- **Audio Processing**: symphonia (codecs/formats), id3, metaflac, mp4ameta, opus_headers
- **Image Processing**: image crate
- **Authentication**: PBKDF2, branca tokens
- **File Watching**: notify / notify-debouncer-full
- **API Documentation**: utoipa (OpenAPI/Swagger)

### Source Structure

```text
server/                 # Rust backend (Rust project root)
├── Cargo.toml
├── Cargo.lock
├── rust-toolchain.toml
├── .rustfmt.toml
├── src/
│   ├── main.rs          # Entry point, CLI parsing, daemon setup, logging
│   ├── app/             # Core application logic
│   │   ├── config.rs    # Configuration management
│   │   ├── index.rs     # Music collection indexing
│   │   ├── scanner.rs   # File scanning and monitoring
│   │   ├── playlist.rs  # Playlist management
│   │   ├── auth.rs      # User authentication
│   │   ├── ddns.rs      # Dynamic DNS updates
│   │   ├── peaks.rs     # Audio waveform extraction
│   │   └── thumbnail.rs # Album art thumbnail generation
│   ├── server/          # HTTP server and API endpoints
│   ├── ui/              # Optional native Windows UI (feature-gated)
│   ├── options.rs       # CLI argument parsing
│   ├── paths.rs         # Path resolution (config, data, cache dirs)
│   └── utils.rs         # Utility functions
├── test-data/           # Test fixtures
└── test-output/         # Test snapshots

web/                    # Frontend web UI (React + TypeScript)
├── package.json
├── src/
└── ...

deploy/                 # Deployment scripts
├── .env.local           # Local Docker config
├── .env.jdc             # JDC server config
├── .registry.env        # Aliyun ACR registry config
├── prepare-image.sh     # Step 1: build web, download binary, build & push image
├── deploy.sh            # Step 2: pull image, run container, verify health
├── rollback.sh          # Rollback to a previous image tag
└── uninstall.sh         # Remove container, preserve config/cache
docs/                   # Documentation
```

## Building and Running

### Prerequisites

- Rust stable toolchain (see `rust-toolchain.toml`)
- Required components: `rust-src`, `rustfmt`

### Development Environment Setup

**Using Nix (recommended):**

```bash
# Enter development shell
nix develop

# Or use direnv
direnv allow
```

**Manual setup:**

```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Install system dependencies (Linux)
# OpenSSL, pkg-config may be required
```

### Build Commands

```bash
# Build (debug)
cargo build

# Build (release with thin LTO)
cargo build --release

# Build with Windows UI feature
cargo build --features ui
```

### Run Commands

```bash
# Run with default settings
cargo run

# Run with custom config and web directory
cargo run -- -w web -c test-config.toml

# Run in foreground (Linux/Unix)
cargo run -- -f

# Show paths (config, data, cache locations)
cargo run -- --show-paths

# Custom bind address and port
cargo run -- --bind-address 127.0.0.1 --port 5050
```

### CLI Options

| Option             | Description                                         |
|--------------------|-----------------------------------------------------|
| `-c, --config`     | Path to configuration file (`.toml`)                |
| `--data`           | Directory for runtime data (playlists, index, auth) |
| `-w, --web-dir`    | Directory to serve as web UI                        |
| `-f, --foreground` | Don't daemonize (Unix only)                         |
| `--bind-address`   | IP address to bind to (default: `0.0.0.0`)          |
| `--port`           | Port to listen on (default: `5050`)                 |
| `--log-level`      | Logging level (error, warn, info, debug, trace)     |
| `--show-paths`     | Display resolved paths and exit                     |

### Testing

```bash
# Run all tests
cargo test

# Run tests (release mode)
cargo test --release

# Run tests with UI feature
cargo test --features ui
```

### Code Formatting

```bash
# Format code (rustfmt configured in .rustfmt.toml)
cargo fmt

# Check formatting
cargo fmt --check
```

## Development Conventions

### Code Style

- **Hard tabs** for indentation (`.rustfmt.toml: hard_tabs = true`)
- Standard Rust naming conventions (snake_case for functions/variables, PascalCase for types)
- Error handling uses `thiserror` for custom error types
- Async code uses `tokio` runtime

### Configuration

- Configuration file format: **TOML**
- Default config location varies by platform:
  - Windows: `%LOCALAPPDATA%/Permafrost/Polaris/polaris.toml`
  - Linux (system): `/usr/local/etc/polaris/polaris.toml`
  - Linux (XDG): `~/.config/polaris/polaris.toml`
  - Or specified via `-c` CLI option

### Testing Practices

- Unit tests located in `src/app/test.rs` and module-level `#[cfg(test)]` blocks
- Test data located in `test-data/` directory
- Test collection available at `test-data/small-collection/`

### Git / Contribution Notes

- This is a hobby project with limited openness to code contributions
- Acceptable contributions: bug fixes, documentation, packaging, issue tracker help
- For non-trivial features, maintain a fork and open discussion threads
- See `docs/CONTRIBUTING.md` for detailed guidelines

### CI/CD

- GitHub Actions workflows in `.github/workflows/`
- Tests run on Ubuntu and Windows
- Coverage tracking via Codecov
- Release automation configured

## API Documentation

When running, interactive API documentation is available at:

```text
http://localhost:5050/api-docs/
```

API version: 8.1 (as of v0.16.0)

## Related Projects

- **Vox Android**: Official mobile app
- **Polarios**: iOS app (third-party)
- **Polarity**: Hardware player (third-party)
- **docker-vox**: Docker containerization

## Documentation Files

- `docs/SETUP.md` - Installation guide
- `docs/CONFIGURATION.md` - Configuration reference
- `docs/CONTRIBUTING.md` - Contribution guidelines
- `docs/MAINTENANCE.md` - Maintenance runbooks
- `docs/DDNS.md` - Remote streaming setup
- `CHANGELOG.md` - Version history
