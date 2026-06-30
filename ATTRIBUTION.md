# Attribution

## Upstream: Palmier Pro

This project is an **independent derivative** of [**Palmier Pro**](https://github.com/palmier-io/palmier-pro) — the AI-native video editor for macOS by [Palmier, Inc.](https://palmier.io), released under the GNU General Public License v3.0.

Palmier Pro is a native macOS application built in Swift on Apple-exclusive frameworks (AppKit/SwiftUI, AVFoundation, CoreML, Speech, Sparkle). It cannot run on Windows. This project rebuilds the platform-locked parts on cross-platform technology while carrying forward Palmier's "built for AI" design philosophy.

### What is reused (conceptually, not code)

The following **design ideas** are inherited from Palmier Pro. No Swift source code is copied — everything is re-implemented in TypeScript and Rust:

| Concept | Palmier Pro | This project |
|---------|------------|--------------|
| Data model | Frame-based timeline, clip/track/project types | Re-implemented in TypeScript (`src/shared/types/project.ts`) |
| Editing algorithms | Undoable command system | Re-implemented (`src/shared/editor/commands.ts`) |
| AI tool contract | Named tools for timeline manipulation | Re-implemented with Zod schemas (`src/main/ai/tools.ts`) |
| MCP server design | Expose editor commands over Model Context Protocol | Re-implemented (`src/main/ai/mcp-server.ts`) |
| "Agent as first-class operator" philosophy | AI uses the same command surface as the user | Preserved |

### What is re-implemented (all of it)

| Concern | Palmier Pro (macOS) | This project (Windows) |
|---------|--------------------|-----------------------|
| UI | AppKit + SwiftUI | Electron + React + TypeScript |
| Video compose / preview | AVFoundation | Rust + wgpu GPU compositor (`native/`) |
| Export | AVFoundation | FFmpeg (`filter_complex`) |
| Visual search | CoreML (SigLIP2) | ONNX Runtime (planned) |
| Transcription | Speech framework | whisper.cpp / faster-whisper (planned) |
| Auto-update | Sparkle | Squirrel / electron-updater (planned) |
| AI generation | Palmier cloud (credits) | Multi-provider, bring-your-own-key |
| Secrets | macOS Keychain | Windows DPAPI via Electron `safeStorage` |

### Statement

This project is **not affiliated with or endorsed by Palmier, Inc.** It uses the "Palmier Pro" name solely to indicate lineage — identifying itself as the Windows port of that upstream project, as permitted under GPL-3.0 with appropriate attribution.

Huge thanks to the Palmier team for open-sourcing their editor and proving that AI-native video editing is both possible and valuable.

---

## Third-party dependencies

See `package.json` and `native/Cargo.toml` for the full dependency list. Key third-party components:

| Component | License | Use |
|-----------|---------|-----|
| Electron | MIT | Desktop shell |
| React | MIT | UI framework |
| wgpu | MIT/Apache-2.0 | GPU abstraction (Rust) |
| napi-rs | MIT | Node native addon bridge |
| FFmpeg | LGPL-2.1+ / GPL-2.0+ | Media decode/encode (external binary) |
| @modelcontextprotocol/sdk | MIT | MCP server |
| @anthropic-ai/sdk | MIT | AI agent (BYOK) |
| Zustand | MIT | State management |
| Tailwind CSS | MIT | Styling |
| Vite | MIT | Build tooling |

FFmpeg is invoked as an external process and is not statically linked.
