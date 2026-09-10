# Upstream Issue Triage

Every open issue captured in
[`UPSTREAM_SNAPSHOT.md`](./UPSTREAM_SNAPSHOT.md) has exactly one row in the
[complete disposition table](#complete-disposition-table) below. The workflow and
the high-priority ledger live in [`UPSTREAM_PARITY.md`](./UPSTREAM_PARITY.md);
this file is the exhaustive per-issue record.

- Upstream baseline: `8805801fa4df8bc2dbc57cb0a854a1f5108f95c6`
- Open issues captured: 60
- Triage date: 2026-09-06 (added #573, #574, #577 â€” the first issues filed against the closed-source upstream, so they can no longer be clarified there; previous pass 2026-08-27 against v0.7.6, before that 2026-07-31 at `8d5648d8`, 51 issues)

## Dispositions

| Disposition | Meaning |
|---|---|
| `Implemented` | Equivalent behavior and regression coverage exist on Windows. |
| `Partial` | Some behavior exists; the missing parts are listed explicitly. |
| `Planned` | Relevant and not implemented yet. |
| `Different by design` | Windows uses a documented alternative contract. |
| `N/A platform` | Depends on Apple-only frameworks or packaging; cannot occur in this stack. |
| `Needs investigation` | Relevance or Windows exposure is not yet established. |

| Disposition | Count |
|---|---|
| Implemented | 28 |
| Partial | 7 |
| Planned | 10 |
| Different by design | 1 |
| N/A platform | 13 |
| Needs investigation | 2 |
| **Total** | **61** |

Three issues filed after upstream retired public development (#573, #574, #577)
are title-only reports that can no longer be clarified upstream. #573 was
reproduced as the blurry-preview class and fixed (see its row); #574 and #577
remain `Needs investigation` until someone can characterize them in this port.

`N/A platform` is not a shortcut. Each such row names the Apple framework,
packaging mechanism, or hosted service that the issue depends on.

## Adopted in the current pass

Eight issues moved to `Implemented` in this pass. Details are in
[implementation notes](#implementation-notes).

| Upstream | Title | Windows owner |
|---|---|---|
| [#68](https://github.com/palmier-io/palmier-pro/issues/68) | Export/seek hang when source fps differs from timeline fps | `shared/media/source-time.ts` |
| [#212](https://github.com/palmier-io/palmier-pro/issues/212) | Playback speed below 0.5x | `shared/editor/playback-rate.ts` |
| [#164](https://github.com/palmier-io/palmier-pro/issues/164) | Keyboard shortcut parity + discoverability | `shared/editor/shortcuts.ts` |
| [#167](https://github.com/palmier-io/palmier-pro/issues/167) | Viewer guides for the preview canvas | `shared/preview/guides.ts` |
| [#17](https://github.com/palmier-io/palmier-pro/issues/17), [#140](https://github.com/palmier-io/palmier-pro/issues/140) | Custom API base URL and OpenAI-compatible providers | `shared/ai/provider-config.ts` |
| [#89](https://github.com/palmier-io/palmier-pro/issues/89) | Fire-and-forget promises | `eslint.config.js`, `shared/editor/state-mirror.ts` |
| [#573](https://github.com/palmier-io/palmier-pro/issues/573) | "video blusa" ("video blurry") — proxy width cap, stale-proxy regeneration, and bilinear preview decode scaling, all fixed; follow-up fixed the same bilinear scaler in the export filter graph | `src/main/media/proxy.ts`, `src/main/media/frame-decoder.ts`, `src/main/media/export-args.ts` |
| [#556](https://github.com/palmier-io/palmier-pro/issues/556) | Playback startup stall on sparse multi-track timelines | `src/main/media/visible-clips.ts` |

Three `Partial` issues also moved substantially without changing disposition:

| Upstream | What landed | What is still missing |
|---|---|---|
| [#58](https://github.com/palmier-io/palmier-pro/issues/58) | An in-flight agent turn can be stopped: `ai:cancel`, a Stop button, and signal checks between rounds and before each remaining tool call. A long multi-step turn is now covered by a stress suite that pins replayed history to linear growth, project consistency across dozens of mutations, and undoability of the whole run (`main/ai/agent.ts`, `agent.stress.test.ts`) | Nothing outstanding for the freeze itself; a headless mode for batch MCP production remains under #302 |
| [#286](https://github.com/palmier-io/palmier-pro/issues/286) | The panel layout is persisted, so a reduced "timeline and video only" workspace survives a restart, the three named arrangements from PR #430 (`default`, `media`, `vertical`) are switchable from the title bar or `Ctrl+1/2/3`, and every workspace boundary is now a draggable divider with persisted positions (`shared/ui/workspace-layout.ts`, `store/ui.ts` incl. `palmier.layout.splits`). **Tab grouping is implemented**: `shared/ui/panel-groups.ts` models the arrangement as a partition of the panels into ordered groups (first entry = region anchor), so a group reuses its region's split width and a panel cannot appear twice; panels are grouped via a keyboard-reachable title-bar menu, grouping persists under `palmier.layout.panelGroups` and is narrowed on read, hiding a tab collapses its region instead of orphaning it, and the Agent stays its region's anchor so regrouping never remounts an in-progress chat (`ui-groups.test.ts`) | Detaching a panel into its own OS window. Not attempted here on purpose: the authoritative project owner lives in the main process, so a second window needs its own state subscription and a conflict-free commit path into the same undo history, and a detached Agent window would have to drive the live agent session; a detach control without that plumbing would be dead |
| [PR #426](https://github.com/palmier-io/palmier-pro/pull/426) | Inspector sliders for Minimum Pause, Speech Padding and Threshold with main-process ownership (`main/media/silence-settings.ts`); scoped removal via optional `clipIds` or whole-timeline sweep (`shared/editor/silence-scoping.ts` + the ripple engine); and the timeline surface â€” a Mark-Silence toggle shading detected spans over audio waveforms, click-to-remove on one span, spans re-detected when the saved controls change | None outstanding for #426 itself; scoping to a marked in/out subrange has no upstream analogue and was not invented |

## Complete disposition table

Ordered by issue number.

| Upstream | Title | Disposition | Windows reason and owner |
|---|---|---|---|
| [#14](https://github.com/palmier-io/palmier-pro/issues/14) | Support more macOS versions (15.x, 14.x) | N/A platform | A macOS deployment-target request. Windows support floor is set by Electron and the `win32` NSIS/portable targets in `package.json`. |
| [#17](https://github.com/palmier-io/palmier-pro/issues/17) | Allow custom API base URL / endpoint | Implemented | `shared/ai/provider-config.ts` validates and normalizes a base URL; Anthropic accepts an optional gateway override, `openai-compatible` requires one. `provider-config.test.ts`. |
| [#18](https://github.com/palmier-io/palmier-pro/issues/18) | Expose text/caption background styling through MCP tools | Implemented | The text domain landed since this row was written: `shared/editor/title.ts` owns the style model and the sanitizer shared by both render paths (canvas preview, FFmpeg drawtext), clips carry size/color/font/bold/align/background/stroke fields, and `set_title_text` exposes them to Agent/MCP â€” including `backgroundColor` as `#RRGGBBAA` with explicit `null` to remove it. Covered by `executor.titles.test.ts` and the title unit tests. |
| [#20](https://github.com/palmier-io/palmier-pro/issues/20) | Linux support | Partial | Packaging groundwork is in place: `package.json` carries a `linux` electron-builder config (AppImage + deb, x64, Video category) and a `dist:linux` script that compiles the Rust/wgpu addon on the host before packing. The native loader is already platform-agnostic — it requires `native/palmier-compositor.node` by fixed name and degrades to CPU compositing when absent. What remains for a shipped build: run `npm run dist:linux` on Linux (napi cross-compilation from Windows is not supported), verify FFmpeg discovery against distro installs, and add a CI job producing artifacts. |
| [#21](https://github.com/palmier-io/palmier-pro/issues/21) | Timeline for Intel Mac support | N/A platform | An Apple-silicon-versus-Intel packaging question. Windows ships x64 portable plus x64/arm64 installers. |
| [#37](https://github.com/palmier-io/palmier-pro/issues/37) | Installation via Homebrew | N/A platform | Homebrew is a macOS package manager. The Windows analogue (a winget manifest) is a distribution task tracked in the roadmap, not this issue. |
| [#39](https://github.com/palmier-io/palmier-pro/issues/39) | Transcription locked to the system language | Partial | A transcription engine now exists without bundling one: `main/ai/transcribe.ts` speaks the OpenAI-compatible `/audio/transcriptions` contract (OpenAI, Groq) over the BYOK runtime from #17/#140, and the executor's `transcribe_audio` tool takes an explicit ISO-639-1 `language` hint per job â€” exactly the per-job-parameter requirement this issue raised. Local/offline STT remains a separate decision. |
| [#41](https://github.com/palmier-io/palmier-pro/issues/41) | Minimum macOS 26 (Tahoe) | N/A platform | A macOS minimum-version policy question with no Windows counterpart. |
| [#44](https://github.com/palmier-io/palmier-pro/issues/44) | Debug build crashes on timeline mutation (EXC_BAD_ACCESS) | N/A platform | A Swift/AppKit memory fault. Timeline mutation on Windows runs in TypeScript over immutable project snapshots, and the compositor is safe Rust, so this crash class is not reachable. |
| [#45](https://github.com/palmier-io/palmier-pro/issues/45) | AI-driven shape annotations + animation presets | Planned | Requires a shape/annotation clip type and a keyframe model, neither of which exists. |
| [#50](https://github.com/palmier-io/palmier-pro/issues/50) | Variable fonts for motion typography | Planned | The static text model exists (`shared/editor/title.ts`: family, bold, size, color, stroke, background), but variable-font axes (weight/width/optical-size interpolation) are not modeled in either render path. |
| [#58](https://github.com/palmier-io/palmier-pro/issues/58) | App freezes (100% CPU, MCP unresponsive) during agent multi-step edits | Implemented | Structurally mitigated: editor tools are bounded pure state operations, decode/export/generation run as separate processes off the IPC reply path, frame requests coalesce newest-wins (`main/media/latest-request.ts`), numeric args are range-checked (#264), and the agent tool loop is now capped at `MAX_TOOL_ROUNDS` so a model that always requests a tool cannot spin. A turn can be stopped from the panel: `ai:cancel` aborts the in-flight request and both provider paths check the signal between rounds and before each remaining tool call, so an unresponsive or runaway turn no longer has to be waited out. A tool already executing is allowed to finish, and a stopped turn records text only, so no orphaned tool call is left in history to poison later requests. Anthropic history assembly was rebuilt so a round is one assistant turn plus its tool results, fixing the growing-conversation retry failure behind the freeze reports. The long-running multi-turn stress suite exists (`agent.stress.test.ts`): linear replay growth, project consistency across dozens of mutations, whole-run undoability. A headless mode for batch MCP production remains under #302. |
| [#59](https://github.com/palmier-io/palmier-pro/issues/59) | 10-bit HDR export (HEVC Main10, BT.2020 + HLG) | Planned | The exporter is 8-bit SDR end to end: the wgpu compositor works in 8-bit RGBA and the FFmpeg pipeline has no pixel-format, transfer-function, or color-primaries controls. Needs a color-management contract shared by preview and export. |
| [#68](https://github.com/palmier-io/palmier-pro/issues/68) | Export hangs on deep seeks into 60 fps sources in a 30 fps timeline | Implemented | Root cause was identical: project-frame offsets were divided by the *source* fps. `shared/media/source-time.ts` is now the single source-time model; the decoder takes `sourceSeconds` instead of an ambiguous frame + fps pair, out-of-range seeks are skipped instead of scanning to EOF, and the exporter resamples each source to the project rate before compositing. `source-time.test.ts`, `frame-decoder.test.ts`. |
| [#70](https://github.com/palmier-io/palmier-pro/issues/70) | RFC: Windows port feasibility and platform abstraction plan | Implemented | This repository is the answer to the RFC. Architecture is recorded in `README.md` and `docs/PROJECT_PLAN.md`. |
| [#75](https://github.com/palmier-io/palmier-pro/issues/75) | App hangs on launch (0% CPU, never draws a window) on macOS 26.2 | N/A platform | An AppKit/`NSApplication` launch stall. Electron window creation on Windows does not use that path. |
| [#89](https://github.com/palmier-io/palmier-pro/issues/89) | Async function without await â€” fire-and-forget Promise | Implemented | Enforced rather than audited once: `no-floating-promises`, `no-misused-promises`, and `await-thenable` are errors under a type-aware ESLint config. The 14 pre-existing violations are fixed, detached work is marked `void` with a stated reason, and the two substantive bugs found are fixed with coverage â€” a failed project save no longer looks like a success (`store/project.ts`), and a failed rendererâ†’main sync no longer permanently desynchronizes the controller the Agent reads (`shared/editor/state-mirror.ts`, `state-mirror.test.ts`). |
| [#91](https://github.com/palmier-io/palmier-pro/issues/91) | Captions: timing drift + no words-per-caption control | Implemented | Both halves are closed. Timing drift: generated captions come from `planCaptions`, which snaps every cue boundary to real word timestamps and only breaks at measured pauses, sentence punctuation, or a simulated line-packing budget — never character-count distribution. Words-per-caption: the planner's `maxWordsPerCue` (plus `maxCharsPerLine`, `maxLines`, `pauseBreakSec`) is exposed in the Captions panel with persisted, narrowed-on-read controls (`palmier.captions.plan`), accepted by the `media:transcribe` IPC payload, and exposed to the Agent's `transcribe_audio` tool; out-of-range values are dropped, not clamped. SRT/VTT import remains as the manual path. (`shared/captions/planner.ts` + tests, `renderer/components/MediaBin.tsx:CaptionsPanel`, `main/ipc/media.ts`, `main/ai/executor.transcribe.test.ts`). |
| [#97](https://github.com/palmier-io/palmier-pro/issues/97) | Chroma key (green-screen removal) | Implemented | `shared/editor/chroma-key.ts` owns a per-clip key color/tolerance/softness/spill model (the same four parameters as upstream's Metal kernel, keyed by #rrggbb instead of an eyedropper hue since this port has no preview color sampler). Preview keys the decoded RGBA frame with a JS per-pixel pass (Canvas has no chromakey filter); export uses FFmpeg's native `colorkey`+`despill` chain; both read the same clip fields so they cannot disagree on what "keyed" means. `set_clip_chroma_key` agent tool and an Inspector color-swatch + three sliders round out the surface (`chroma-key.test.ts`, `executor.chroma-key.test.ts`). |
| [#107](https://github.com/palmier-io/palmier-pro/issues/107) | Video preview stops every time Claude sends an MCP command | Implemented | Agent and MCP edits arrive as `editor:apply-from-main`, are adopted as one undoable step, and the resulting project revision requests a fresh composite at the current playhead; per-window generations stop a stale async frame from replacing newer output. The preview is not torn down or paused by a tool call. |
| [#117](https://github.com/palmier-io/palmier-pro/issues/117) | Evaluate and Install palmier-pro | N/A platform | A macOS install/evaluation thread. Windows installation is a different mechanism entirely (NSIS and portable builds), documented in `README.md`. |
| [#118](https://github.com/palmier-io/palmier-pro/issues/118) | AI content labels for media assets | Partial | Local on-device tags now exist as a zero-cost heuristic (`shared/media/tags.ts`: type, resolution bucket, orientation, duration bucket, codec, ai-generated flag, filename keywords). Tags render under each media tile and make the search box match on any tag substring without a separate filter UI. No AI description yet; probe metadata remains the source of truth. |
| [#122](https://github.com/palmier-io/palmier-pro/issues/122) | Expose MCP server to local network | Different by design | The server now listens on HTTP, but deliberately only on loopback: `main/ai/mcp-http.ts` binds 127.0.0.1, refuses any non-loopback peer, and requires a generated bearer token on every request — the same conclusion upstream reached. Exposing it to the LAN remains refused; that would need explicit network-interface selection, transport encryption, and a threat model this local editor does not have. |
| [#137](https://github.com/palmier-io/palmier-pro/issues/137) | Support multiple concurrent Palmier tabs/sessions | Planned | `main/application.ts` owns a single `mainWindow`, and the main-process `EditorController` mirror plus the MCP server are process-wide singletons. Multi-session needs per-window controller identity and session routing on the MCP surface first. |
| [#140](https://github.com/palmier-io/palmier-pro/issues/140) | Multi-provider LLM support (DeepSeek, custom OpenAI-compatible APIs) | Implemented | `main/ai/openai-compatible.ts` speaks `/chat/completions` with tool calling over `fetch`, no vendor SDK added. Presets cover OpenAI, OpenRouter, Groq, Together, Ollama, and LM Studio, plus a custom endpoint. The same `ToolExecutor` runs regardless of provider. `openai-compatible.test.ts`, `agent.openai-compatible.test.ts`. |
| [#141](https://github.com/palmier-io/palmier-pro/issues/141) | `{"code":"... Server Error"}` | N/A platform | An error from upstream's hosted chat backend. This port is bring-your-own-key with no Palmier-operated service in the request path. |
| [#142](https://github.com/palmier-io/palmier-pro/issues/142) | Add Codex CLI agent provider | Planned | The provider registry added for #17/#140 covers HTTP endpoints only. A CLI-subprocess provider is a different transport (spawn, stream, sandbox the working directory) and is not implemented. |
| [#154](https://github.com/palmier-io/palmier-pro/issues/154) | XML import/export for professional NLE compatibility | Planned | No interchange layer. Tracked jointly with #289 in the parity ledger. |
| [#155](https://github.com/palmier-io/palmier-pro/issues/155) | Compound clips (nested sequences) | Planned | The project model has a single flat timeline; a clip cannot reference another timeline. Needs a nested-sequence type plus recursive preview and export resolution. |
| [#156](https://github.com/palmier-io/palmier-pro/issues/156) | Library / Event / Project hierarchy | Planned | Projects are single files opened individually; there is no library container or browser. |
| [#157](https://github.com/palmier-io/palmier-pro/issues/157) | Named presets for color grading and shot settings | Partial | The effect stack is now user-reachable on both surfaces: the Inspector exposes Brightness/Contrast/Saturation/Hue sliders plus seven built-in named presets (Neutral/Warm/Cool/Black & White/Faded/Punchy/Vintage) that apply a whole grade as one undo step, with Neutral clearing the fields so a reset clip reads ungraded everywhere, and the Agent has `set_clip_color_grade` with the same partial-patch/default-clears/clear-all contract, which `copy_clip_settings` also transfers between clips including invert (`shared/editor/color-grade.ts`, `Inspector.tsx:ColorGradeControls`, `main/ai/tools.ts`, `main/ai/executor.ts`, `color-grade.test.ts`, `executor.color-grade.test.ts`). User-defined presets are implemented too: "Save current as preset…" names the clip's current grade, saved looks appear in a "My presets" group beside the built-ins (narrowed on read from `palmier.grade.presets`, capped at 50, sanitized per field), can be deleted from the same row, and the multi-clip Inspector applies any preset to the whole selection in one undo step (`renderer/store/grade-presets.ts`, `Inspector.tsx`). Remaining: shot settings beyond the color grade. |
| [#158](https://github.com/palmier-io/palmier-pro/issues/158) | Audio editing tools beyond volume control | Implemented | All three tool families exist end to end. Gain automation: `volumeDb` keyframes (#535 audio slice) override the static volume in preview and export. Three-band EQ: `eqLowDb`/`eqMidDb`/`eqHighDb` (±15 dB; low 100 Hz shelf, mid 1 kHz bell Q 1, high 3 kHz shelf) render through preview biquads and FFmpeg `bass`/`equalizer`/`treble` from the same shared module (`shared/audio/eq.ts`), with Inspector sliders that clear a band at 0 dB and `set_clip_eq`. Compression/limiting: a per-clip compressor (threshold dBFS, ratio, attack/release ms, makeup dB) driven from the same five values by the preview `DynamicsCompressorNode` (plus a dedicated makeup gain node) and the export `acompressor` filter, with ratio 1 as the off switch, Inspector checkbox+sliders, and `set_clip_compressor`; `copy_clip_settings` carries pan, EQ, and compressor between clips. One documented difference: the soft-knee curve is engine-specific (Web Audio fixed at 6 dB vs FFmpeg's own knee factor), so the knee region is approximate while threshold/ratio/attack/release/makeup match. |
| [#164](https://github.com/palmier-io/palmier-pro/issues/164) | Keyboard shortcuts for common editing actions (Premiere/Resolve parity) | Implemented | `shared/editor/shortcuts.ts` is a declarative catalogue with strict modifier matching and a conflict test; the handler dispatches on command id with a compile-time exhaustiveness guard, so an unbound command fails the build. Adds edit-point navigation, mark navigation, snapping, fit-to-window, project I/O, and guide toggles, and a generated shortcut sheet (F1 or `?`). `shortcuts.test.ts`, `edit-points.test.ts`, `timeline-navigation.test.ts`. |
| [#165](https://github.com/palmier-io/palmier-pro/issues/165) | Noise reduction for audio clips | Planned | Same missing effect stack as #97, on the audio side. |
| [#166](https://github.com/palmier-io/palmier-pro/issues/166) | Preview ignores aspect ratio; move export to a dedicated workspace panel | Implemented | The aspect-ratio half: the preview reads the live canvas from project settings and resizes with it, and the compositor composites at the project canvas. The panel half: export docks as a right-hand workspace column riding the persisted panel flags (fourth `PanelKey`, title-bar toggle with active state, Ctrl+M, Escape), with mount-scoped effects and live event subscriptions â€” settings adjust between renders, which a modal could not do. Also fixed en route: a verbatim-duplicated captions checkbox block. |
| [#167](https://github.com/palmier-io/palmier-pro/issues/167) | Viewer guides for the preview canvas | Implemented | `shared/preview/guides.ts` holds normalized geometry for a centre cross, thirds, a grid, and SMPTE action/title safe areas, with the cross aspect-corrected so its arms stay square on any canvas. `GuideOverlay` draws it as a non-interactive SVG above the canvas; it is never part of compositor or exporter input, so guides cannot be baked into an export. Toggles live in the preview toolbar and on `G` / `Shift+G`. `guides.test.ts`, `ui-guides.test.ts`. |
| [#173](https://github.com/palmier-io/palmier-pro/issues/173) | Google sign-in stalls on macOS 26 | N/A platform | Depends on Clerk and `ASWebAuthenticationSession`. This port has no account system or OAuth flow; keys are user-supplied and stored via DPAPI. |
| [#174](https://github.com/palmier-io/palmier-pro/issues/174) | Auto Remove Silence: detect and ripple-delete silent regions | Implemented | On-device RMS envelope detection (FFmpeg feed into a pure `SilenceDetector`), ripple close through a snapshot-undoable `ReplaceClipsCommand`, plus Inspector and `remove_silence` agent paths, both resolving the same saved Minimum Pause / Speech Padding / Threshold controls (PR #426). `silence-detector.test.ts`, `remove-silence.test.ts`, `silence-settings.test.ts`, `executor.silence.test.ts`. |
| [#195](https://github.com/palmier-io/palmier-pro/issues/195) | Request for Windows Support | Implemented | The purpose of this repository. x64 portable plus x64/arm64 NSIS installers. |
| [#211](https://github.com/palmier-io/palmier-pro/issues/211) | Support auto save on change | Implemented | Debounced crash-recovery autosave writes an atomic snapshot through the serialized project writer and is cleared on a clean explicit save. `useAutosave`, `main/ipc/autosave.ts`, `project-writer.test.ts`. |
| [#212](https://github.com/palmier-io/palmier-pro/issues/212) | Playback speed beyond 0.25x | Implemented | `shared/editor/playback-rate.ts` owns the presets (0.25x through 10x), normalizes any rate at the store boundary so a non-finite value cannot poison the frame accumulator, and centralizes J/K/L shuttle behavior. The playback loop also clamps catch-up to 250 ms so returning from a background tab cannot trigger a thousand-iteration render burst. `playback-rate.test.ts`. |
| [#222](https://github.com/palmier-io/palmier-pro/issues/222) | Intel Mac: "incorrect executable format" (binary is arm64-only) | N/A platform | A Mach-O fat-binary packaging problem. Windows publishes separate x64 and arm64 artifacts. |
| [#252](https://github.com/palmier-io/palmier-pro/issues/252) | Sharing an idea for caption transcription | Partial | The pipeline now exists end to end: `transcribe_audio` transcribes a library asset over the BYOK OpenAI-compatible runtime with word timestamps, and `planCaptions` lays cues snapped to word boundaries onto a fresh track. What remains is the idea-sharing UX this request describes. |
| [#262](https://github.com/palmier-io/palmier-pro/issues/262) | Windows help | Implemented | Same request as #195; this port is the answer. |
| [#264](https://github.com/palmier-io/palmier-pro/issues/264) | Agent crash: out-of-range integer frame arg traps Int arithmetic | Implemented | Frame arguments are validated at the Zod boundary (finite, integer, within `[0, MAX_FRAME]`), clamped again in `ToolExecutor`, and guarded in `EditorController` via `clampFrame`/`asValidFrame`. `safe-number.test.ts`, `controller.overflow.test.ts` including the upstream `1e19` repro. |
| [#286](https://github.com/palmier-io/palmier-pro/issues/286) | Ability to restructure parts | Partial | The request is workspace layout, in CapCut's terms: rearrange the panels, detach the chat into its own window, or reduce the view to just the timeline and video. Nothing here is platform-specific, so it applies in full, and two of the three now work. Hiding panels already worked from the title bar, and that layout is persisted, so "only the timeline and video in view" survives a restart instead of resetting on every launch. Stored flags are narrowed on read, and a panel the saved layout does not mention falls back to its default, so a layout written by a build with a different set of panels still loads. Rearranging arrived with the named presets adopted from PR #430 â€” `default`, `media` and `vertical`, on `Ctrl+1/2/3` â€” which is the shape upstream chose over free-form dragging and the one that actually answers the vertical-video case. Missing: grouping panels as tabs, detaching one into a separate window, and resizable splitters with remembered divider positions. `shared/ui/workspace-layout.ts`, `store/ui.ts`, `ui-panels.test.ts`, `ui-layout.test.ts`. |
| [#287](https://github.com/palmier-io/palmier-pro/issues/287) | Custom STT | Implemented | Pluggable endpoint: the Captions tab takes a custom OpenAI-compatible server URL + key (self-hosted faster-whisper included), persisted via `main/media/transcribe-config.ts` with narrowing-on-read, and transcription prefers it over the AI provider runtime. |
| [#289](https://github.com/palmier-io/palmier-pro/issues/289) | XML imports and exports | Planned | Duplicate of #154 in substance; tracked as one interchange work item. |
| [#302](https://github.com/palmier-io/palmier-pro/issues/302) | Local MCP batch reel production: headless/stability + `manage_tracks` mis-targeting | Implemented | All three gaps are closed. Mis-targeting: `manage_tracks` addresses every entry by stable track id or current index, exactly one, never both. Stability: covered by the #58 row. **The MCP endpoint is real now**: the running app hosts a loopback, token-authenticated, stateless Streamable-HTTP MCP server (`main/ai/mcp-http.ts`, `mcp-http-settings.ts`) with a paste-ready client config in AI Settings, and new project tools (`new_project`, `open_project`, `save_project`) make file-based batch pipelines possible — open a `.vproj`, edit with the same validated tools the UI uses, save. `export_project` is now real as well: the tool renders the timeline through the same `Exporter` the delivery panel uses (the exporter takes a progress sink instead of a window, so the tool call gets the same receipts), with absolute-path validation and FFmpeg's own error text surfaced. **Windowless mode exists**: `--mcp-server` boots Electron with no window, hosts the loopback endpoint, and prints one `[mcp] {…}` JSON line with the URL/token so a CI harness can drive open → edit → export → save (verified live: 53 tools listed, unauthenticated requests refused with 401). |
| [#310](https://github.com/palmier-io/palmier-pro/issues/310) | Hermes / Herm MCP client integration | Implemented | The endpoint is standard MCP over Streamable HTTP on loopback with a bearer token, and AI Settings shows a paste-ready `mcpServers` block (`url` + `Authorization` header) — so any compliant client, Hermes included, can attach to the running editor. There is deliberately no Hermes-specific branded flow; the generic config is the integration surface. |
| [#453](https://github.com/palmier-io/palmier-pro/issues/453) | Media import silently drops files, no error shown | Implemented | Closed on this port with both gaps fixed. `main/media/import-expansion.ts` expands a dropped folder recursively â€” depth â‰¤ 8 (matching the relink walk), a 500-file ceiling that appends one truncation notice, symlinks never followed so junction cycles terminate by rule â€” and imports the supported media inside, where before the directory itself was refused as "not a supported media file" because it has no media extension. A folder that cannot be listed reports `Could not read folder X`; unsupported files *inside* an expanded folder are ignored quietly (sidecars like `.srt`/`thumbs.db` are not failures) while top-level unsupported drops keep their named refusal; explicitly picked files import even after a folder hit the ceiling. `shared/media/import-summary.ts` renders the full skip list (first three reasons + `(+N more)`) in both the media panel banner and the timeline drop toast, replacing the old `errors[0]`-only display. `import-expansion.test.ts`, `import-summary.test.ts`. |
| [#464](https://github.com/palmier-io/palmier-pro/issues/464) | Please support Apple account login | N/A platform | Same family as #173: Sign in with Apple depends on `ASWebAuthenticationSession` and Apple's hosted OAuth endpoints. This port has no account system; API keys are user-supplied. |
| [#484](https://github.com/palmier-io/palmier-pro/issues/484) | Add Antigravity CLI integration via MCP | Implemented | Same surface as #310: `main/ai/mcp-http.ts` serves standard MCP over loopback HTTP with a bearer token, and AI Settings emits the client config. Any Streamable-HTTP-capable CLI can attach; no Antigravity-specific config generation exists because the generic block is the contract. |
| [#516](https://github.com/palmier-io/palmier-pro/issues/516) | A more clear way to find the manual editing tools | Implemented | Discoverability of manual tools versus the Agent. A searchable command palette (Ctrl+K / Ctrl+Shift+P) now inventories every editing command from the shortcut catalogue and shares the same dispatcher as the keyboard layer so a palette row does exactly what its chord does (F1 remains for chord reference). Reachable from the timeline toolbar; no guided tour yet (upstream's #458 answer). |
| [#527](https://github.com/palmier-io/palmier-pro/issues/527) | Not working for macOS Sequoia | N/A platform | A macOS 15 compatibility report against an app whose minimum is macOS 26. The Windows support floor is set by Electron, not by an Apple OS version. |
| [#532](https://github.com/palmier-io/palmier-pro/issues/532) | Migrate MCP server to the 2026-07-28 stateless protocol | Partial | The substantive migration is live: `main/ai/mcp-http.ts` serves Streamable HTTP in stateless mode (no session id generator, a fresh MCP server per request, JSON responses), which is exactly the no-persistent-session contract this request describes. Negotiation is now verified against the SDK's own constants instead of a literal: with `@modelcontextprotocol/sdk` 1.30.0 the endpoint negotiates 2025-11-25 (the newest revision the 1.x SDK speaks) and still answers older revisions on request, and it enforces the spec's per-request `MCP-Protocol-Version` rules — an unsupported value on a later request is a 400, an absent header is accepted (a stateless server has no negotiated state to look up and falls back to the default revision). The declared floor moved from `^1.12.1` to `^1.30.0`, because the old range could resolve a build that speaks only 2024-11-05 and does not validate that header at all. **Remaining, with evidence:** no published `@modelcontextprotocol/sdk` carries 2026-07-28 — the latest is 1.30.0, whose `SUPPORTED_PROTOCOL_VERSIONS` stops at 2025-11-25. The revision ships under renamed v2 packages instead (`@modelcontextprotocol/server@2.0.0` + `@modelcontextprotocol/node@2.0.0`, published 2026-07-27, driven by `createMcpHandler`/`toNodeHandler`), and that upgrade is a migration rather than a bump: it requires Node ≥20 in the Electron main process and Zod v4 (`registerTool` takes a Standard Schema; Zod v3 is no longer supported — this repo is on 3.25.76), and 2026-07-28 removes the handshake and sessions outright (`initialize`/`initialized` and `Mcp-Session-Id` are gone, replaced by per-request `Mcp-Protocol-Version`/`Mcp-Method`/`Mcp-Name` headers and a mandatory `server/discover`). Sources: the npm registry entry for `@modelcontextprotocol/sdk`, the v2 README and `upgrade-to-v2` guide, and the 2026-07-28 spec changelog. Regression coverage: `mcp-http.test.ts` derives every revision from `LATEST_PROTOCOL_VERSION`/`SUPPORTED_PROTOCOL_VERSIONS`, so the next SDK bump cannot silently re-stale this row. |
| [#536](https://github.com/palmier-io/palmier-pro/issues/536) | v0.7.4 regression of #465: scrub decode blocks on the tokio blocking pool | N/A platform | Scrub audio does not exist on Windows (#418 disposition); playhead scrubbing is visual only, so neither the original defect nor this regression can occur. The transferable rule â€” decode work must stay off the interaction path â€” is already enforced by process separation and `latest-request.ts`. |
| [#573](https://github.com/palmier-io/palmier-pro/issues/573) | "video blusa" ("video blurry") — title-only report with screen-recording links | Implemented | Investigated as the blurry-preview report the title names. The Windows preview had three compounding softness sources, all fixed: (1) the proxy width cap was 960 px, so any full-frame clip on a 1920 canvas decoded a proxy upscaled 2× (4× from 4K sources) — cap raised to 1920 and CRF 26→20 so the proxy survives a 2× zoom; (2) the proxy cache key did not include the transcode policy, so every asset with an old narrow proxy kept it forever — the key now carries a policy version and stale proxies regenerate on demand; (3) the frame decoder scaled with bilinear, leaving a staircase texture on magnified previews — now bicubic. A follow-up found the same bilinear scaler in the EXPORT filter graph: export composites from originals at full resolution, but any clip rendered at a size other than its source (images, reframed/moved footage) magnified through `scale=...:flags=bilinear` — softness in the final output, not just the preview. Both scalers are now bicubic. `proxy.test.ts` pins the cap ≥ 1920; `frame-decoder.test.ts` and `export-args.test.ts` pin their scalers. |
| [#574](https://github.com/palmier-io/palmier-pro/issues/574) | "ui size" — title-only report, no body or follow-up | Needs investigation | Same closed-source situation as #573 and #577: filed the day upstream retired public development, no body, no comments, can't be clarified. Most plausibly a window/panel-sizing complaint, which this port addresses more than upstream did: the main window enforces a 1024×680 hard minimum (`main/application.ts`), three persisted layout presets with Ctrl+1/2/3 (`shared/ui/workspace-layout.ts`, `renderer/store/ui.ts`), four draggable dividers with persisted and range-clamped positions (`SPLITS_LIMITS`: media 200–720, inspector 200–560, preview 300–1100, timeline 160–600), and per-panel 200/300/160 px shrink floors so nothing is dragged out of the window under pressure. The one surface with no coverage is explicit display-scaling / DPI control — Chromium handles device scale factor by default, but there is no user-facing zoom or scaling setting and no high-DPI-specific layout adjustment; on a 125%/150%-scaled Windows display the UI relies on Chromium's auto-scaling. The parity doc's 1600×1000 / 1024×680 no-overflow matrix is a manual check, not an automated test, and at 1024 wide with the default split positions (media 480 + inspector 320) both shown the preview column is ~96 px too narrow for its 300 px floor and is clipped by the `overflow-hidden` workspace row — a configuration that is valid and persisted, so it can reproduce on a fresh launch at the minimum size. |
| [#577](https://github.com/palmier-io/palmier-pro/issues/577) | "Videos" — title-only report, no body or follow-up | Needs investigation | Filed 2026-08-27 (one day before upstream retired public development via PR #578), no body, no comments, no labels — like #573 and #574 it can no longer be clarified upstream, and in practice it was never clarified: no follow-up was ever added, so the intent is unknowable. Most plausible readings, all of which this port touches to varying degrees: (a) a video-generation / AI-video feature ask — this port ships a live `generate_media` tool over a fal.ai + Replicate + HiggsField registry (text-to-video and image-to-video), with static crop (#568), inspect-frame capture for MCP vision clients (#565), generation cost display (#570), and swap-clip-media with arming UI (#500); the specific upstream grouped-model features from PRs #415/#416/#411 (promptless lip sync, AI video reframing with a reference image, Seed Audio) remain Planned as catalog+schema extensions on top of that working registry — see the parity ledger's PR #411/#415/#416 row. (b) a general video-editing ask — this port is a full non-linear video editor (preview compositor, proxy decode, frame decode, seek, playback rate, chroma key, 12 blend modes, FFmpeg export with bicubic scaling, XML-import planned under #154/#289). (c) a bug report about something video-related being broken — uninterpretable without the body. Because the title gives no signal about which of these the reporter meant, relevance cannot be established and the row stays `Needs investigation`; if a future reader can pin a specific meaning, the row is ready to move to Implemented (playback/import/export/chroma-key/blend-modes all ship), Partial (video generation has the registry and tool but not the grouped-model features), or Planned (HDR export, XML interchange, lip sync/reframe models). |
| [#556](https://github.com/palmier-io/palmier-pro/issues/556) | Playback can take 50+ seconds to start on sparse timelines with many tracks | Implemented | Profiled and fixed. The Windows analogue of upstream's per-frame build cost was real: the compositor's visible-layer scan did a track-list `find` per clip in its filter and **two** per sort comparison, so every composite and prefetch request paid O(clips Ã— tracks) even when the tracks were empty at that frame. `main/media/visible-clips.ts` now builds one track index per call and resolves ordering keys before sorting â€” O(clips + tracks), same semantics (audio exclusion, hidden tracks, half-open range, track-order layering). Measured over 120 resolutions on a 40-track / 3000-clip timeline: worst-case placement 120.9 ms â†’ 8.65 ms (**14Ã—**, and no longer growing with track count); typical placement 2Ã—. The per-pass media lookup got the same treatment (one index instead of a scan per clip). The absolute stall upstream reports never reproduced here â€” bounded decode pool and newest-wins coalescing cap the rest â€” so this closes as hardening with a scaling regression guard (`visible-clips.test.ts`). |

## Implementation notes

Detailed notes for adopted work. Older entries are retained for provenance.

### #68 â€” source fps versus timeline fps

`MediaAsset.duration`, `Clip.inPoint`, `Clip.outPoint`, and `Clip.durationFrames`
are all stored in **project** frames. The preview previously converted a
project-frame offset into seconds by dividing by the *asset* fps, so a 60 fps
source in a 30 fps timeline sought to half the intended time, and a 24 fps source
overshot by 1.25x â€” far enough on a long clip to seek past EOF, which made FFmpeg
scan the file until the five-second timeout and presented as a hang.

The fix introduces one shared model (`shared/media/source-time.ts`) and removes
the ambiguity at the interface: `DecodeRequest` now carries `sourceSeconds`
rather than a frame index plus an fps to interpret it with. The cache key
includes the asset, the output dimensions, and the millisecond source time, which
also closes a cross-size collision that became reachable once project resolution
could change. Out-of-range seeks are rejected before FFmpeg is spawned, and the
exporter inserts `fps=<project fps>` ahead of each overlay so sources are
resampled to the project timebase rather than queueing extra frames.

### #164 â€” keyboard shortcuts

Bindings live in data, not in a switch statement. `shortcutConflicts()` is
asserted empty by a test, so two commands can never silently claim one chord, and
matching is strict about modifiers â€” `C` razors but `Ctrl+C` is left alone, which
a test pins down for `Ctrl+C/V/X/F/P/W/R/T`. The handler dispatches on command id
through a `switch` with a `never` exhaustiveness guard, so adding a command
without handling it fails the build instead of shipping a dead key.

Two incidental fixes came out of it: `End` landed in the timeline's trailing
padding rather than on the last frame of material, and `fitToWindow` was not
clamped to the viewport's zoom ceiling. Fit-to-window also needed a real width â€”
the timeline panel now publishes its measured lane width to the store, because
neither the toolbar nor the keyboard layer can see that element.

### #167 â€” viewer guides

Geometry is normalized to the unit square, so one set of numbers serves any
project resolution and the scaled-to-fit preview. The centre cross is the
exception: its arm length is taken from the shorter edge and converted per axis,
or it would stretch with the aspect ratio. Guides are drawn by the renderer above
the canvas and are deliberately absent from compositor and exporter input.

### #17 / #140 â€” provider configuration

The base URL is the security-relevant field, since it decides where an API key
and the project's timeline structure are sent. `validateBaseUrl` rejects
non-`http(s)` schemes, credentials embedded in the URL, a query string or
fragment on a base URL, and plaintext HTTP to anything that is not a loopback
address. Loopback HTTP is allowed because local runtimes cannot present a
certificate and their traffic never leaves the machine â€” refusing it would rule
out the main reason to configure a custom endpoint at all. Validation runs in the
main process as well as the form, because the renderer is not the only thing that
can reach the IPC channel, and the persisted config file is user-writable.

The settings panel states which category the configured endpoint falls into
before the assistant is used.

### #89 â€” fire-and-forget promises

Made a build constraint rather than a one-time sweep. Beyond marking intentional
detached work, two real defects surfaced:

- `ProjectStore.save()` ignored `result.success`, so a failed write left the
  project dirty while the caller proceeded as though it had been saved. It now
  rejects, and `Ctrl+S` surfaces the failure.
- `useEditorSync` recorded a snapshot as mirrored *before* the IPC call resolved.
  One transient failure therefore left the main-process controller holding a
  stale project while the renderer believed it was current â€” and because the
  dedupe check then matched, that snapshot was never retried. The Agent and MCP
  server read that controller, so the visible symptom was tools acting on a stale
  timeline. `StateMirror` now records a snapshot only after the peer confirms it.

Silent catches that remain are the genuinely ignorable ones â€” best-effort temp
file cleanup, audio-context teardown, prefetch misses â€” and each states why.
Sustained preview composite failures are now reported once per outage instead of
being dropped at frame rate.

### Earlier adopted work

| Upstream | Windows status |
|---|---|
| [#200](https://github.com/palmier-io/palmier-pro/issues/200) | Fixed with #264 above; same validation chain. |
| [#182](https://github.com/palmier-io/palmier-pro/issues/182) | Fixed. The exporter no longer trusts exit code 0 â€” it stats the output and reports `export:error` on a missing or zero-byte file. |
| [PR #218](https://github.com/palmier-io/palmier-pro/pull/218) | Adopted. `native/src/geometry.rs` is shared by preview and export, and aspect-aware refit now runs on the project-settings change path via `EditorController.applyProjectSettings` (see PR #417 in the parity ledger). |
| [PR #179](https://github.com/palmier-io/palmier-pro/pull/179) | Applied. Project settings are applied before frame durations are derived; `mediaAssetsFromProbeResults` converts probe seconds using the project fps. |
| [PR #192](https://github.com/palmier-io/palmier-pro/pull/192) | Noted. Project and media state must be restored before the preview's first composite. |
| [PR #180](https://github.com/palmier-io/palmier-pro/pull/180) | Noted for the waveform phase: peak-envelope extraction, not duration-based sampling. |
| [PR #189](https://github.com/palmier-io/palmier-pro/pull/189) | Noted for the captions phase; see #91. |
| [PR #216](https://github.com/palmier-io/palmier-pro/pull/216), [PR #219](https://github.com/palmier-io/palmier-pro/pull/219) | Partially designed. Generation cache and job tracking exist; persistent in-flight recovery and import placeholders remain planned. |
| [PR #203](https://github.com/palmier-io/palmier-pro/pull/203), [PR #213](https://github.com/palmier-io/palmier-pro/pull/213) | Shipped. Twelve W3C separable blend modes in the wgpu compositor with an exact CPU fallback, Inspector controls, and a `set_clip_blend_mode` tool that rejects audio. |

## Feature parity backlog

Upstream capabilities worth matching that are not defects. Each has a row in the
table above.

- Animated / word-timed captions with a max-words-per-caption control (#91).
- FCPXML / XMEML interchange for Resolve and Final Cut (#154, #289).
- Text outline, stroke, and caption background styling (#18, #50).
- Chroma key, noise reduction, and named grading presets â€” all blocked on a
  shared effect stack (#97, #165, #157).
- Compound clips (#155) and a Library/Event/Project hierarchy (#156).
- 10-bit HDR export (#59).
- Optional cloud video understanding and AI media labels (#118).
- A Codex CLI agent provider (#142) and Hermes MCP client integration (#310).

---

_Last reconciled with the parity workflow: 2026-09-07 (headers recounted and brought in line with the table; #573 and #556 added to the current-pass adoption list; #573 follow-up — export scaler — folded into its row; #574 row expanded with the full UI-size surface and the known default-splits-at-minimum-window overflow edge case)._






