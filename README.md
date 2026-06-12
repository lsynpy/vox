# Vox

A self-hosted music streaming server, to enjoy your music collection from any computer or mobile device.

This is a fork of the original [Polaris](https://github.com/agersant/polaris) project, customized
for personal use with ARM64 deployment.

## Original Project

- **Server**: [github.com/agersant/polaris](https://github.com/agersant/polaris)
- **Web UI**: [github.com/agersant/polaris-web](https://github.com/agersant/polaris-web)
- **Demo**: [demo.polaris.stream](https://demo.polaris.stream) (user: `demo_user`, pass: `demo_password`)
- **License**: MIT

## Project Structure

| Directory | Description                       |
|-----------|-----------------------------------|
| `server/` | Rust backend (Cargo project root) |
| `web/`    | Vue.js frontend web UI            |
| `deploy/` | Deployment scripts                |
| `docs/`   | Documentation                     |

## Development Workflow

Follow this workflow for all changes:

1. **Design docs** - Write design documentation in `docs/` for significant changes
2. **Coding** - Implement the changes
3. **Test & fix bugs** - Run `prek run -a` for linting, then `make test` for tests
4. **Commit** - Commit with conventional commits (`feat:`, `fix:`, `chore:`, etc.)
5. **Deploy to local** - Run `make deploy ENV=local` to test in Docker

## Build & Run

### Server (Rust)

```bash
cd server
cargo build --release
cargo run -- -f   # -f = foreground (don't daemonize)
```

### Web UI (Vue.js)

```bash
cd web
npm install       # first time only
npm run dev       # Vite dev server with hot reload
```

### Tests

```bash
cd server && cargo test    # Rust unit tests
cd web && npm test         # Playwright E2E tests
```

API docs available at `http://localhost:5050/api-docs/` after starting the server.

## Deployment

Both local and remote deployments use pre-built binaries from GitHub Actions — no local Rust compilation.

### 2-Step Deploy Flow

```bash
# Step 1: Build web, download binary, build & push image to registry
make prepare

# Step 2: Deploy to local Docker or JDC
make deploy ENV=local    # local Docker
make deploy ENV=jdc      # remote JDC server
```

Or combine both:

```bash
make prepare-deploy ENV=jdc
```

Image tags use `YYYYMMDD-sha` format (e.g. `20260413-abc1234`) for easy rollback.

### GitHub Actions Workflows

Manually trigger binary builds (no auto-build on push):

```bash
gh workflow run "Build AMD64 Binary"   # for x86_64
gh workflow run "Build ARM64 Binary"   # for ARM64
```

### Environment Files

| File                   | Purpose                                   |
|------------------------|-------------------------------------------|
| `deploy/.env.local`    | Local Docker config (port, mount paths)   |
| `deploy/.env.jdc`      | JDC server config (SSH host, mount paths) |
| `deploy/.registry.env` | Aliyun ACR registry URL and namespace     |

### Rollback

```bash
deploy/rollback.sh <previous-tag>
```
