# Project Plan — Palmier Pro Windows

## Status

| Phase | Description | Status |
|-------|-------------|--------|
| P0 | Repo + scaffold | ✅ Done |
| P1 | Media import + bin (ffprobe, thumbnails) | ✅ Done |
| P2 | Timeline editing (trim/move/split/ripple/snap), undo/redo | 🔲 Next |
| P3 | Real-time multi-track preview (Rust GPU compositor) | 🔲 |
| P4 | FFmpeg export | 🔲 |
| P5 | AI agent + in-app chat (BYOK) | 🔲 |
| P6 | Embedded MCP server (Claude Code / Cursor) | 🔲 |
| P7 | AI generation — Higgs Field (multi-provider) | 🔲 |
| P8 | fal.ai / Replicate + Windows installer | 🔲 |

## Shipped beyond the core roadmap

- **Per-clip blend modes** — 12 W3C separable modes (multiply, screen, overlay, darken, lighten, color-dodge, color-burn, hard-light, soft-light, difference, exclusion). Applied at the layer-compositing stage in the wgpu pipeline (backdrop ping-pong + in-shader compositing), with a pixel-matched Rust CPU fallback. Exposed via the Inspector (blend dropdown + opacity) and the `set_clip_blend_mode` agent/MCP tool.
- **Auto remove silence** — on-device RMS-envelope silence detection (FFmpeg → pure, fully-tested `SilenceDetector`), ripple-closing the gaps as a single undoable operation. Exposed via the Inspector "Remove Silence" button and the `remove_silence` agent/MCP tool.
- **Transitions** — per-clip fade in/out and cross-dissolve. Fades route through the compositor's existing per-layer opacity (`effectiveOpacity` shared by preview and FFmpeg's `fade` filter on export), so preview and export stay consistent with no shader changes. Cross-dissolve overlaps two adjacent clips and applies complementary fades. Exposed via Inspector fade fields, on-clip fade ramps, and the `set_clip_fade` / `cross_dissolve` agent tools.
- **Wipe / slide transitions** — geometric in-transitions. Wipe (4 directions, soft edge) is a per-layer alpha mask in the wgpu shader (`composite.wgsl` + matching Rust CPU fallback); slide (4 directions) offsets the layer transform per frame. Exposed via Inspector type/direction selectors and the `set_clip_transition` agent tool. _Note: preview-only for now — geometric transitions are not yet applied on FFmpeg export (tracked follow-up; fades and cross-dissolve do export)._
- **Upstream issue hardening** — see `UPSTREAM_ISSUES.md`. Numeric-overflow safety (#200), export write verification (#182), crash-recovery autosave (#211).

---

## Phase details

### P0 — Scaffold ✅

- Electron + React + TypeScript + Vite project structure
- Rust native addon scaffold (napi-rs + wgpu + D3D12/Vulkan)
- EditorController + Command system (shared, undoable)
- AI tool contract (Zod schemas, 13 tools)
- MCP server skeleton
- In-app agent skeleton (Anthropic BYOK)
- Project format (.vproj), save/open
- Attribution & licensing

### P1 — Media import ✅

- File dialog (video/audio/images)
- ffprobe metadata extraction
- Thumbnail generation (ffmpeg)
- Media bin UI (grid, type icons, duration)
- MediaAsset model + project serialization

### P2 — Timeline editing

- Interactive clip rendering on tracks
- Drag-to-move clips (with snapping)
- Trim handles (head/tail drag)
- Split at playhead (razor tool / keyboard shortcut)
- Ripple delete
- Multi-select + group operations
- Keyboard shortcuts (J/K/L, I/O, C, Delete)
- Undo/redo UI indicators

### P3 — Real-time preview

- Activate wgpu render pipeline in Rust addon
- Texture atlas for decoded frames
- Multi-layer composition at 60fps
- Canvas element receives compositor output via SharedArrayBuffer
- Playback transport (play/pause/stop, J/K/L scrub)
- Audio mixing (Web Audio API or native)

### P4 — FFmpeg export

- Build filter_complex from timeline state
- geometry.rs `to_ffmpeg_filter()` for pixel-exact transforms
- Export dialog (format, quality, resolution presets)
- Progress reporting (% complete)
- Background export (non-blocking)

### P5 — AI agent

- In-app chat panel UI
- BYOK key management (encrypted via DPAPI)
- Anthropic Claude integration with tool-use loop
- Streaming responses with tool call visualization
- Context: agent reads timeline, media bin, project settings
- Multi-turn conversation with tool state

### P6 — MCP server

- stdio transport for Claude Code / Cursor
- All 13 tools exposed over MCP
- Connection status indicator in app
- MCP configuration file for external tools

### P7 — Generation (Higgs Field)

- Provider-agnostic generation adapter
- Higgs Field API integration
- Image generation → insert to bin → place on timeline
- Video generation (text-to-video, image-to-video)
- Audio generation (text-to-speech, music)
- Reference frame support

### P8 — Multi-provider + installer

- fal.ai adapter
- Replicate adapter
- electron-builder NSIS installer
- Auto-update (Squirrel / electron-updater)
- Code signing (if certificate available)

---

## Architecture decisions

### Renderer-authoritative state with main mirroring (editor sync)

The renderer's timeline `EditorController` is the single source of truth so UI editing stays local and 60fps. The main-process controller is kept mirrored via `editor:sync-from-renderer` (`setProjectSilent`, no echo). Agent / MCP edits run against the main controller and are pushed back via `editor:apply-from-main`, which the renderer adopts as one undoable step (`adoptProject` → `ReplaceProjectCommand`). This is what makes AI edits appear live on the timeline. Media imports are registered with the timeline controller (`importAssets`) so they are part of the synced project and the agent can place them.

### Why Electron + Rust hybrid (not pure Rust / not pure Electron)

- **Rust (native addon):** GPU compositor at 60fps, geometry math shared with FFmpeg export. This is where ReelMind (pure Canvas/JS) hits its ceiling — multiple decoded video streams composited every frame in JS will stutter under load.
- **Electron + React + TS:** AI/MCP/generation ecosystem is TypeScript-native. Fighting the language there would slow the product-value work. Rich component ecosystem for video editor UI (timeline, waveforms, panels).
- **Shared surface:** EditorController (TS) is the single command entry point. The Rust compositor only does rendering — it doesn't own state.

### Frame-based time

All timing is integer frames (not floating-point seconds). Matches upstream Palmier Pro and eliminates floating-point drift in timeline math.

### Command pattern for edits

Every mutation is a named, undoable Command. This enables:
- Undo/redo (obvious)
- AI auditability (log what the agent did)
- Consistent behavior across UI, agent, and MCP
- Serializable edit history

### BYOK only

No cloud backend. Users bring their own API keys (Anthropic, OpenAI, Higgs Field, fal.ai, Replicate). Keys encrypted at rest via Windows DPAPI through Electron's `safeStorage`.
