# Vox

A self-hosted music streaming server, to enjoy your music collection from any computer or mobile device.

This is a fork of the original [Polaris](https://github.com/agersant/polaris) project, customized
for personal use with ARM64 deployment.

## Project Structure

| Directory | Description                           |
|-----------|---------------------------------------|
| `server/` | Rust backend (Cargo project root)     |
| (removed) | Vue.js web UI — deleted, CLI-only now |
| `deploy/` | Deployment scripts                    |
| `cli/`    | macOS CLI player (vox-cli)            |
| `docs/`   | Documentation                         |

---

## CLI Player (Vox-Cli)

macOS CLI 音乐播放器，对接 Vox 音乐库。通过 mpv 播放，由 Unix IPC socket 控制。

### 依赖

- [mpv](https://mpv.io/) — `brew install mpv`
- Node.js (v18+)

### 安装

```bash
ln -sf ~/code/vox/cli/vox-cli.sh /usr/local/bin/vox-cli
```

Fish 自动补全：`~/.config/fish/completions/vox-cli.fish`
开机自启 mpv：LaunchAgent `com.vox.mpv`（`--idle` 暂停启动，KeepAlive 自动恢复）

### 用法

| 命令                      | 说明                            |
|---------------------------|---------------------------------|
| `play <query>`            | 搜索并播放（支持简繁中文）      |
| `pause / resume / toggle` | 暂停 / 继续 / 切换              |
| `stop / next / prev`      | 停止 / 下一首 / 上一首          |
| `seek +10 / seek -30`     | 快进 / 快退                     |
| `volume 60 / sysvol 80`   | 设 mpv 音量 / 设 macOS 系统音量 |
| `queue <query>`           | 加入队列                        |
| `list`                    | 显示当前队列                    |
| `shuffle`                 | 随机化队列                      |
| `jump <query>`            | 跳转到队列中匹配的曲目          |
| `playlist [name]`         | 加载播放列表（默认 fav）        |
| `playlist -s [name]`      | 加载 + 随机播放                 |
| `pl-add <query>`          | 添加到当前播放列表              |
| `pl-remove <query>`       | 从播放列表移除                  |
| `status / now`            | 播放状态 / 当前曲目             |
| `search <query>`          | 搜索音乐库                      |
| `help`                    | 帮助                            |

### 架构

```text
┌──────────────┐     IPC socket      ┌──────────────┐
│   vox-cli    │ ──────────────────▶ │  mpv daemon  │
│  (Node.js)   │     ~/.vox/player/  │  --no-video  │
└──────────────┘                     │  --idle      │
       │                             └──────┬───────┘
       │ Vox API                              │ Lua on_load hook
       ▼                                      ▼
┌──────────────┐                     ┌──────────────┐
│  Vox Server  │                     │ cover-hook   │
│  192.168.1:  │                     │  .lua        │
│      5050    │                     └──────────────┘
└──────────────┘
```

- **音频**：mpv 守护进程，Unix IPC socket (`~/.vox/player/mpv.sock`) 控制
- **音乐源**：Vox 服务器 `http://192.168.100.1:5050`
- **状态**：实时从 mpv IPC 或 Vox API 读取，**零本地缓存**
- **日志**：`/tmp/vox-player/player.log`
- **音量**：`volume` 控制 mpv，`sysvol` 控制 macOS

### 封面处理（Cover Issue）

封面由 mpv 的 Lua hook (`cover-hook.lua`) 在 `on_load` 事件中处理，这是解决"封面永远滞后一首"这个 bug 的关键。

**问题**：mpv 仅在文件加载时读取 `cover-art-files` 属性。此前用 Node.js 监听 `path` 属性变化来设置封面，但 `path` 变化事件在 mpv **已加载完成文件之后**才触发——此时 mpv 已读取过封面，设置无效。结果封面永远显示上一首歌的。

**修复**：用 mpv 的 `on_load` hook。它在 mpv 即将加载文件时**暂停加载流程**，此时 hook 执行：

1. 从 mpv `path` 属性提取 Vox 路径
2. 检查 `/tmp/vox-player/cover-{song}.jpg` 缓存
3. 缓存命中 → 直接设置 `cover-art-files`
4. 缓存未命中 → Vox API 认证 → 下载缩略图 → 写入磁盘 → 设置 `cover-art-files`
5. 返回 → hook 自动 ack → mpv 继续加载文件

mpv 在加载时读到正确的 `cover-art-files`，封面与歌曲同步显示。

**为什么手动 IPC 也能正常工作？** `cover-art-files` 是粘性的——设置后跨文件加载保持不变。如果你在上首歌播放时手动 `echo '{"command":["set","cover-art-files","/tmp/cover.jpg"]}' | nc -U ~/.vox/player/mpv.sock`，mpv 加载下一首时读到的就是这个旧值。碰巧对了而已，hook 才是正确方案。

**关键洞察**：`hook_add` 无法通过 IPC 调用（mpv 0.41.0），必须用 Lua 脚本。Lua hook 返回时自动 ack，无需显式 `hook_ack`。

### 调试

封面异常时检查：

1. **播放器日志** `/tmp/vox-player/player.log`

```text
[2026-06-12 18:15:19] [INFO  ] Cover hook registered (on_load)
[2026-06-12 18:15:26] [INFO  ] ────────────────────────────────────────
[2026-06-12 18:15:26] [INFO  ] Track path changed  <decoded-url>
[2026-06-12 18:15:26] [INFO  ] Cover set (cache)  /tmp/vox-player/cover-xxx.jpg
[2026-06-12 18:15:26] [INFO  ] music playing
```

2. **IPC 查询当前封面**：`echo '{"command":["get_property","cover-art-files"]}' | nc -U ~/.vox/player/mpv.sock`

### 媒体键

| 键       | 无歌时                                          | 有歌时        |
|:---------|:------------------------------------------------|:--------------|
| **Play** | 加载 fav 列表 + 随机播放 (`voxctl playlist -s`) | 切换暂停/播放 |

### 封面缓存

下载路径：`/tmp/vox-player/cover-{歌曲全名}.jpg`
文件名不可逆（基于歌曲路径），重复下载覆盖同名文件。无主动清理，用满重启即可。

---

## Original Project

- **Server**: [github.com/agersant/polaris](https://github.com/agersant/polaris)
- **Web UI**: [github.com/agersant/polaris-web](https://github.com/agersant/polaris-web)
- **Demo**: [demo.polaris.stream](https://demo.polaris.stream) (user: `demo_user`, pass: `demo_password`)
- **License**: MIT

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

### Tests

```bash
cd server && cargo test    # Rust unit/integration tests
```

API docs available at `http://localhost:5050/api-docs/` after starting the server.

## Deployment

Both local and remote deployments use pre-built binaries from GitHub Actions — no local Rust compilation.

Image tags use `YYYYMMDD-sha` format (e.g. `20260413-abc1234`) for easy rollback.

```bash
# Deploy to local Docker or JDC
make deploy ENV=local    # local Docker
make deploy ENV=jdc      # remote JDC server
```

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
