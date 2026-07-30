# Palmier Pro - Windows

**Early-stage Windows rebuild of Palmier Pro: an AI-native video editor built with Electron, React, Rust/wgpu, FFmpeg, and MCP.**

> Status: early alpha. The desktop application currently supports project creation, media import, metadata and thumbnail extraction, and saving/opening `.vproj` projects. Timeline, compositor, export, agent, and MCP functionality is under active development. Some experimental editing and agent-command implementations already exist in the codebase but are not yet considered release-ready. See `docs/PROJECT_PLAN.md` for the full roadmap.

---

## Current Alpha Functionality

- Create, save, and open `.vproj` project files.
- Import video, audio, and image media into a project.
- Extract media metadata with FFmpeg/ffprobe.
- Generate thumbnails for imported media.
- Maintain shared TypeScript editor state for future UI, agent, and MCP commands.

Screenshots and demo GIFs will be added once the Windows alpha UI is captured from this rebuild. Do not use upstream Palmier screenshots as proof of this Windows version.

---

## Credit

This is an **independent derivative** of [**Palmier Pro**](https://github.com/palmier-io/palmier-pro), the AI-native video editor for macOS by [Palmier, Inc.](https://palmier.io), released under GPL-3.0. Palmier Pro is a native macOS/Swift app; this project rebuilds the platform-locked parts on cross-platform technology while carrying forward Palmier's "built for AI" design.

Huge thanks to the Palmier team. See `ATTRIBUTION.md` for the full statement.

This project is **not affiliated with or endorsed by Palmier, Inc.**

---

## Vision

The core idea, inherited from Palmier Pro: an AI agent is a first-class operator of a real, non-linear video editor, not a chatbot beside it. The agent should be able to read the timeline, cut filler words, add captions, place clips, and generate new media through the **same validated command surface** a human uses.

The planned MCP interface will allow tools such as Codex, Claude Code, and Cursor to inspect and modify the timeline through the same validated command surface used by the application.

---

## Architecture

| Layer | Technology |
|-------|------------|
| Desktop shell | Electron 35 |
| UI | React 19 + TypeScript + Tailwind |
| GPU compositor | Rust + wgpu (napi-rs native addon) |
| Video decode/encode | FFmpeg (external process) |
| AI agent (BYOK) | Agent/provider layer under active development |
| MCP server | @modelcontextprotocol/sdk (planned stdio surface) |
| State | Zustand (renderer), EditorController (shared) |

### Why Electron + Rust/wgpu

The project is being designed around a Rust + wgpu native compositor for GPU-accelerated multi-track preview through D3D12 or Vulkan. Electron, React, and TypeScript provide the editor interface and AI/MCP integration layer, while FFmpeg handles media inspection and planned export workflows. The long-term goal is to share geometry and timing logic between preview and export so both paths produce consistent results.

---

## Getting Started

### Prerequisites

- Windows 10/11
- [Node.js](https://nodejs.org) 22.12+ (developed on v24)
- [FFmpeg](https://ffmpeg.org/) 6+ on your `PATH` (developed on 8.0.1)
- [Rust](https://rustup.rs/) stable, for the native compositor addon

### Run

Launch a production-style local build:

```bash
npm install
npm run build:rust
npm start
```

For development with hot reload, use:

```bash
npm run dev
```

Both commands launch the Electron window. `npm run dev:electron` is retained as
an alias for `npm run dev`.

Before nontrivial development, audit the current macOS upstream:

```bash
npm run upstream:audit
```

The required sync workflow is documented in
[`docs/UPSTREAM_PARITY.md`](docs/UPSTREAM_PARITY.md). The generated
[`docs/UPSTREAM_SNAPSHOT.md`](docs/UPSTREAM_SNAPSHOT.md) tracks every open
upstream issue and recent merged pull request.

### Build

```bash
npm run build
npm run dist
```

### Test

```bash
npm test
npm run typecheck
npm run lint
```

Rust checks:

```bash
cd native
cargo check
cargo test
```

---

## Project Structure

```text
palmier-pro-windows/
|-- native/              # Rust GPU compositor addon (napi-rs + wgpu)
|   |-- src/lib.rs       # napi exports
|   |-- src/gpu.rs       # wgpu device init (D3D12/Vulkan)
|   |-- src/compositor.rs# multi-layer frame compositor
|   `-- src/geometry.rs  # affine transforms + FFmpeg filter generation
|-- src/
|   |-- main/            # Electron main process
|   |-- preload/         # Context-isolated bridge (window.palmier)
|   |-- renderer/        # React UI
|   `-- shared/          # Pure TS modules (no Electron/React deps)
|-- docs/                # Design docs and project plan
`-- package.json
```

---

## Contributing

This repository is early alpha and welcomes focused, test-backed contributions. Please read `CONTRIBUTING.md` before opening issues or pull requests.

---

## Security

This project has security-sensitive surfaces including Electron IPC, local API-key storage, MCP commands, FFmpeg process execution, file-path validation, and native Rust bindings. Please read `SECURITY.md` before reporting vulnerabilities.

---

## License

[GPL-3.0-or-later](./LICENSE). As a derivative of GPL-3.0 software, this project is and remains GPL-3.0. See `ATTRIBUTION.md` for upstream credit and third-party notices.
