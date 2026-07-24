# Project Plan - Palmier Pro Windows

> This file tracks the original implementation phases. For the current
> product-level feature order, UI constraints, open-source component strategy,
> and release gates, see [`PRODUCT_ROADMAP.md`](./PRODUCT_ROADMAP.md).

## Status

| Phase | Description | Status |
|-------|-------------|--------|
| P0 | Repo + scaffold | Done |
| P1 | Media import + bin (ffprobe, thumbnails) | Done |
| P2 | Timeline editing (trim/move/split/ripple/snap), undo/redo | Next |
| P3 | Real-time multi-track preview (Rust GPU compositor) | Planned |
| P4 | FFmpeg export | Planned |
| P5 | AI agent + in-app chat (BYOK) | Planned |
| P6 | Embedded MCP server (Codex / Claude Code / Cursor) | Planned |
| P7 | AI generation - Higgs Field and provider adapters | Planned |
| P8 | fal.ai / Replicate + Windows installer | Planned |

## Experimental Implementations Under Validation

These implementations exist in the current codebase but should not be considered stable or release-ready until their corresponding roadmap phases are completed and integration-tested.

| Feature | Schema defined | Executor implemented | UI connected | Integration tested | Released |
|---------|----------------|----------------------|--------------|--------------------|----------|
| Per-clip blend modes | Yes | Partial | Partial | No | No |
| Auto remove silence | Yes | Partial | Partial | Unit tests only | No |
| Fade and cross-dissolve transitions | Yes | Partial | Partial | Unit tests only | No |
| Wipe / slide transitions | Yes | Partial | Partial | No | No |
| Export command surface | Yes | Partial | Partial | No | No |
| Media generation providers | Yes | Partial | No | No | No |
| MCP command surface | Partial | Partial | No | No | No |
| Crash-recovery autosave | No | Partial | Partial | No | No |

Notes:

- **Per-clip blend modes**: W3C separable blend-mode logic exists in the compositor path and CPU fallback, with Inspector and agent/MCP command surfaces under validation.
- **Auto remove silence**: RMS-envelope silence detection and ripple-closing logic exist with unit coverage, but the workflow still needs full timeline and media integration testing.
- **Transitions**: Fade and cross-dissolve logic exists in shared editor code. Geometric wipe/slide behavior is preview-oriented and is not yet validated for FFmpeg export.
- **Upstream issue hardening**: See `UPSTREAM_ISSUES.md` for numeric-overflow safety, export write verification, and crash-recovery follow-ups.

---

## Phase Details

### P0 - Scaffold

- Electron + React + TypeScript + Vite project structure
- Rust native addon scaffold (napi-rs + wgpu + D3D12/Vulkan)
- EditorController + Command system (shared, undoable)
- Shared Zod-based AI tool contract for editor inspection and command execution
- MCP server skeleton
- In-app agent skeleton
- Project format (`.vproj`), save/open
- Attribution and licensing

### P1 - Media Import

- File dialog for video, audio, and image files
- ffprobe metadata extraction
- Thumbnail generation through FFmpeg
- Media bin UI with grid, type icons, and duration
- MediaAsset model and project serialization

### P2 - Timeline Editing

- Interactive clip rendering on tracks
- Drag-to-move clips with snapping
- Trim handles for head/tail drag
- Split at playhead through razor tool / keyboard shortcut
- Ripple delete
- Multi-select and group operations
- Keyboard shortcuts (J/K/L, I/O, C, Delete)
- Undo/redo UI indicators

### P3 - Real-Time Preview

- Activate wgpu render pipeline in Rust addon
- Texture atlas for decoded frames
- Multi-layer composition target and measurement harness
- Canvas output path from compositor to renderer
- Playback transport (play/pause/stop, J/K/L scrub)
- Audio mixing through Web Audio API or native path

### P4 - FFmpeg Export

- Build `filter_complex` from timeline state
- Generate FFmpeg transforms from shared geometry
- Export dialog with format, quality, and resolution presets
- Progress reporting
- Background export without blocking the renderer

### P5 - AI Agent

- In-app chat panel UI
- BYOK key management through Electron safe storage
- Provider integration with auditable tool-use loop
- Streaming responses with tool-call visualization
- Context assembly from timeline, media bin, and project settings
- Multi-turn conversation with tool state

### P6 - MCP Server

- stdio transport for Codex, Claude Code, and Cursor
- Validated editor inspection and command tools exposed over MCP
- Connection status indicator in app
- MCP configuration examples for external tools

### P7 - Generation

- Provider-agnostic generation adapter
- Higgs Field API integration
- Image generation to media bin and timeline placement
- Video generation (text-to-video, image-to-video)
- Audio generation (text-to-speech, music)
- Reference frame support

### P8 - Multi-Provider + Installer

- fal.ai adapter
- Replicate adapter
- electron-builder NSIS installer
- Auto-update through electron-updater
- Code signing if certificate is available

---

## Architecture Decisions

### Renderer-Authoritative State With Main Mirroring

The renderer's timeline `EditorController` is the single source of truth so UI editing stays local and responsive. The main-process controller is mirrored through `editor:sync-from-renderer` (`setProjectSilent`, no echo). Agent / MCP edits run against the main controller and are pushed back through `editor:apply-from-main`, which the renderer adopts as one undoable step (`adoptProject` to `ReplaceProjectCommand`). This makes AI edits appear live on the timeline once the feature path is fully connected.

### Why Electron + Rust Hybrid

- **Rust native addon:** GPU compositor and geometry math for the planned preview/export path.
- **Electron + React + TypeScript:** UI, AI/MCP integration, provider SDKs, and desktop shell.
- **Shared command surface:** `EditorController` is the single command entry point. The Rust compositor renders; it does not own editor state.

### Frame-Based Time

All timing is integer frames rather than floating-point seconds. This matches upstream Palmier Pro and eliminates floating-point drift in timeline math.

### Command Pattern For Edits

Every mutation should be a named, undoable command. This supports undo/redo, AI auditability, consistent behavior across UI/agent/MCP, and serializable edit history.

### BYOK Only

No project-hosted cloud backend is planned for user API keys. Users bring their own API keys. Keys should be encrypted at rest through Electron's `safeStorage` on supported platforms.
