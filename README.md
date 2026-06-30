# Palmier Pro — Windows

**An AI-native video editor for Windows — you and your agent generate and edit video together, right on the timeline.**

> Status: early development. The desktop app runs, imports media into a project, and saves/opens `.vproj` projects. Timeline editing, real-time preview, export, the AI agent, and generation are coming phase by phase. See `docs/PROJECT_PLAN.md` for the full roadmap.

---

## Credit

This is an **independent derivative** of [**Palmier Pro**](https://github.com/palmier-io/palmier-pro) — the AI-native video editor for macOS by [Palmier, Inc.](https://palmier.io), released under GPL-3.0. Palmier Pro is a native macOS/Swift app; this project rebuilds the platform-locked parts on cross-platform technology while carrying forward Palmier's "built for AI" design.

Huge thanks to the Palmier team. See `ATTRIBUTION.md` for the full statement.

This project is **not affiliated with or endorsed by Palmier, Inc.**

---

## Vision

The core idea, inherited from Palmier Pro: an AI agent is a first-class operator of a real, non-linear video editor — not a chatbot beside it. The agent reads the timeline, cuts filler words, adds captions, places clips, and generates new media, using the **same command surface** a human uses. External tools like Claude Code and Cursor drive it over **MCP**.

---

## Architecture

| Layer | Technology |
|-------|-----------|
| Desktop shell | Electron 35 |
| UI | React 19 + TypeScript + Tailwind |
| GPU compositor | Rust + wgpu (napi-rs native addon) |
| Video decode/encode | FFmpeg (external process) |
| AI agent (BYOK) | @anthropic-ai/sdk |
| MCP server | @modelcontextprotocol/sdk (stdio) |
| State | Zustand (renderer), EditorController (shared) |


### Key differentiator vs. pure-JS editors

The **Rust + wgpu GPU compositor** (`native/`) handles real-time multi-track preview at 60fps via D3D12/Vulkan — something a Canvas/HTML5 compositor structurally cannot match with multiple decoded video streams. The geometry engine is shared between preview and export, ensuring pixel-exact consistency.

---

## Getting started (development)

### Prerequisites

- Windows 10/11
- [Node.js](https://nodejs.org) 20+ (developed on v24)
- [FFmpeg](https://ffmpeg.org/) 6+ on your `PATH` (developed on 8.0.1)
- [Rust](https://rustup.rs/) (stable) — for the native compositor addon

### Run

```bash
npm install          # install JS dependencies
npm run build:rust   # compile the native compositor (requires Rust)
npm run dev          # launch the app in development (hot reload)
```

### Build

```bash
npm run build        # production build (TS + Vite + electron-builder)
npm run dist         # package as Windows installer
```

### Test

```bash
npm test             # unit tests (vitest)
npm run typecheck    # TypeScript type checking
npm run lint         # ESLint
```

---

## Project structure

```
palmier-pro-windows/
├── native/              # Rust GPU compositor addon (napi-rs + wgpu)
│   ├── src/lib.rs       #   napi exports
│   ├── src/gpu.rs       #   wgpu device init (D3D12/Vulkan)
│   ├── src/compositor.rs#   multi-layer frame compositor
│   └── src/geometry.rs  #   affine transforms + FFmpeg filter gen
├── src/
│   ├── main/            # Electron main process
│   │   ├── index.ts     #   app entry, window management
│   │   ├── ipc/         #   IPC handlers (project, media, system)
│   │   └── ai/          #   AI agent, MCP server, tool contract
│   ├── preload/         # Context-isolated bridge (window.palmier)
│   ├── renderer/        # React UI
│   │   ├── components/  #   TitleBar, MediaBin, Preview, Timeline
│   │   ├── store/       #   Zustand project store
│   │   └── styles/      #   Tailwind CSS
│   └── shared/          # Pure TS modules (no Electron/React deps)
│       ├── types/       #   Project schema, API types
│       ├── editor/      #   EditorController, Command system
│       └── utils/       #   Frame/timecode helpers
├── docs/                # Design docs & project plan
└── package.json
```

---

## License

[GPL-3.0-or-later](./LICENSE). As a derivative of GPL-3.0 software, this project is and remains GPL-3.0. See `ATTRIBUTION.md` for upstream credit and third-party notices.
