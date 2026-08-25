# Upstream Issue Triage

Every open issue captured in
[`UPSTREAM_SNAPSHOT.md`](./UPSTREAM_SNAPSHOT.md) has exactly one row in the
[complete disposition table](#complete-disposition-table) below. The workflow and
the high-priority ledger live in [`UPSTREAM_PARITY.md`](./UPSTREAM_PARITY.md);
this file is the exhaustive per-issue record.

- Upstream baseline: `3026f72ed2924c2e6f876ab34ed6854b744407f9`
- Open issues captured: 57
- Triage date: 2026-08-21 (re-triaged against v0.7.6; previous pass 2026-07-31 at `8d5648d8`, 51 issues)

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
| Implemented | 21 |
| Partial | 0 |
| Planned | 23 |
| N/A platform | 14 |
| Needs investigation | 0 |
| **Total** | **58** |

Every open issue in the captured snapshot now has a concrete disposition; none
remain under investigation.

`N/A platform` is not a shortcut. Each such row names the Apple framework,
packaging mechanism, or hosted service that the issue depends on.

## Adopted in the current pass

Six issues moved to `Implemented` in this pass. Details are in
[implementation notes](#implementation-notes).

| Upstream | Title | Windows owner |
|---|---|---|
| [#68](https://github.com/palmier-io/palmier-pro/issues/68) | Export/seek hang when source fps differs from timeline fps | `shared/media/source-time.ts` |
| [#212](https://github.com/palmier-io/palmier-pro/issues/212) | Playback speed below 0.5x | `shared/editor/playback-rate.ts` |
| [#164](https://github.com/palmier-io/palmier-pro/issues/164) | Keyboard shortcut parity + discoverability | `shared/editor/shortcuts.ts` |
| [#167](https://github.com/palmier-io/palmier-pro/issues/167) | Viewer guides for the preview canvas | `shared/preview/guides.ts` |
| [#17](https://github.com/palmier-io/palmier-pro/issues/17), [#140](https://github.com/palmier-io/palmier-pro/issues/140) | Custom API base URL and OpenAI-compatible providers | `shared/ai/provider-config.ts` |
| [#89](https://github.com/palmier-io/palmier-pro/issues/89) | Fire-and-forget promises | `eslint.config.js`, `shared/editor/state-mirror.ts` |

Three `Partial` issues also moved substantially without changing disposition:

| Upstream | What landed | What is still missing |
|---|---|---|
| [#58](https://github.com/palmier-io/palmier-pro/issues/58) | An in-flight agent turn can be stopped: `ai:cancel`, a Stop button, and signal checks between rounds and before each remaining tool call. A long multi-step turn is now covered by a stress suite that pins replayed history to linear growth, project consistency across dozens of mutations, and undoability of the whole run (`main/ai/agent.ts`, `agent.stress.test.ts`) | Nothing outstanding for the freeze itself; a headless mode for batch MCP production remains under #302 |
| [#286](https://github.com/palmier-io/palmier-pro/issues/286) | The panel layout is persisted, so a reduced "timeline and video only" workspace survives a restart, the three named arrangements from PR #430 (`default`, `media`, `vertical`) are switchable from the title bar or `Ctrl+1/2/3`, and every workspace boundary is now a draggable divider with persisted positions (`shared/ui/workspace-layout.ts`, `store/ui.ts` incl. `palmier.layout.splits`) | Tab grouping and detaching a panel into its own window |
| [PR #426](https://github.com/palmier-io/palmier-pro/pull/426) | Inspector sliders for Minimum Pause, Speech Padding and Threshold with main-process ownership (`main/media/silence-settings.ts`); scoped removal via optional `clipIds` or whole-timeline sweep (`shared/editor/silence-scoping.ts` + the ripple engine); and the timeline surface — a Mark-Silence toggle shading detected spans over audio waveforms, click-to-remove on one span, spans re-detected when the saved controls change | None outstanding for #426 itself; scoping to a marked in/out subrange has no upstream analogue and was not invented |

## Complete disposition table

Ordered by issue number.

| Upstream | Title | Disposition | Windows reason and owner |
|---|---|---|---|
| [#14](https://github.com/palmier-io/palmier-pro/issues/14) | Support more macOS versions (15.x, 14.x) | N/A platform | A macOS deployment-target request. Windows support floor is set by Electron and the `win32` NSIS/portable targets in `package.json`. |
| [#17](https://github.com/palmier-io/palmier-pro/issues/17) | Allow custom API base URL / endpoint | Implemented | `shared/ai/provider-config.ts` validates and normalizes a base URL; Anthropic accepts an optional gateway override, `openai-compatible` requires one. `provider-config.test.ts`. |
| [#18](https://github.com/palmier-io/palmier-pro/issues/18) | Expose text/caption background styling through MCP tools | Planned | `ClipType` reserves `title` but there is no text or font model, so there is no styling surface to expose. Blocked on the text domain. |
| [#20](https://github.com/palmier-io/palmier-pro/issues/20) | Linux support | Planned | Electron, FFmpeg, and wgpu are all portable, so nothing in the architecture prevents it. No Linux build target, native prebuild, or CI job exists yet. |
| [#21](https://github.com/palmier-io/palmier-pro/issues/21) | Timeline for Intel Mac support | N/A platform | An Apple-silicon-versus-Intel packaging question. Windows ships x64 portable plus x64/arm64 installers. |
| [#37](https://github.com/palmier-io/palmier-pro/issues/37) | Installation via Homebrew | N/A platform | Homebrew is a macOS package manager. The Windows analogue (a winget manifest) is a distribution task tracked in the roadmap, not this issue. |
| [#39](https://github.com/palmier-io/palmier-pro/issues/39) | Transcription locked to the system language | Planned | No transcription subsystem exists on Windows. When one lands, the source language must be an explicit per-job parameter rather than read from the OS locale. |
| [#41](https://github.com/palmier-io/palmier-pro/issues/41) | Minimum macOS 26 (Tahoe) | N/A platform | A macOS minimum-version policy question with no Windows counterpart. |
| [#44](https://github.com/palmier-io/palmier-pro/issues/44) | Debug build crashes on timeline mutation (EXC_BAD_ACCESS) | N/A platform | A Swift/AppKit memory fault. Timeline mutation on Windows runs in TypeScript over immutable project snapshots, and the compositor is safe Rust, so this crash class is not reachable. |
| [#45](https://github.com/palmier-io/palmier-pro/issues/45) | AI-driven shape annotations + animation presets | Planned | Requires a shape/annotation clip type and a keyframe model, neither of which exists. |
| [#50](https://github.com/palmier-io/palmier-pro/issues/50) | Variable fonts for motion typography | Planned | Blocked on the same missing text/font model as #18. |
| [#58](https://github.com/palmier-io/palmier-pro/issues/58) | App freezes (100% CPU, MCP unresponsive) during agent multi-step edits | Implemented | Structurally mitigated: editor tools are bounded pure state operations, decode/export/generation run as separate processes off the IPC reply path, frame requests coalesce newest-wins (`main/media/latest-request.ts`), numeric args are range-checked (#264), and the agent tool loop is now capped at `MAX_TOOL_ROUNDS` so a model that always requests a tool cannot spin. A turn can be stopped from the panel: `ai:cancel` aborts the in-flight request and both provider paths check the signal between rounds and before each remaining tool call, so an unresponsive or runaway turn no longer has to be waited out. A tool already executing is allowed to finish, and a stopped turn records text only, so no orphaned tool call is left in history to poison later requests. Anthropic history assembly was rebuilt so a round is one assistant turn plus its tool results, fixing the growing-conversation retry failure behind the freeze reports. The long-running multi-turn stress suite exists (`agent.stress.test.ts`): linear replay growth, project consistency across dozens of mutations, whole-run undoability. A headless mode for batch MCP production remains under #302. |
| [#59](https://github.com/palmier-io/palmier-pro/issues/59) | 10-bit HDR export (HEVC Main10, BT.2020 + HLG) | Planned | The exporter is 8-bit SDR end to end: the wgpu compositor works in 8-bit RGBA and the FFmpeg pipeline has no pixel-format, transfer-function, or color-primaries controls. Needs a color-management contract shared by preview and export. |
| [#68](https://github.com/palmier-io/palmier-pro/issues/68) | Export hangs on deep seeks into 60 fps sources in a 30 fps timeline | Implemented | Root cause was identical: project-frame offsets were divided by the *source* fps. `shared/media/source-time.ts` is now the single source-time model; the decoder takes `sourceSeconds` instead of an ambiguous frame + fps pair, out-of-range seeks are skipped instead of scanning to EOF, and the exporter resamples each source to the project rate before compositing. `source-time.test.ts`, `frame-decoder.test.ts`. |
| [#70](https://github.com/palmier-io/palmier-pro/issues/70) | RFC: Windows port feasibility and platform abstraction plan | Implemented | This repository is the answer to the RFC. Architecture is recorded in `README.md` and `docs/PROJECT_PLAN.md`. |
| [#75](https://github.com/palmier-io/palmier-pro/issues/75) | App hangs on launch (0% CPU, never draws a window) on macOS 26.2 | N/A platform | An AppKit/`NSApplication` launch stall. Electron window creation on Windows does not use that path. |
| [#89](https://github.com/palmier-io/palmier-pro/issues/89) | Async function without await — fire-and-forget Promise | Implemented | Enforced rather than audited once: `no-floating-promises`, `no-misused-promises`, and `await-thenable` are errors under a type-aware ESLint config. The 14 pre-existing violations are fixed, detached work is marked `void` with a stated reason, and the two substantive bugs found are fixed with coverage — a failed project save no longer looks like a success (`store/project.ts`), and a failed renderer→main sync no longer permanently desynchronizes the controller the Agent reads (`shared/editor/state-mirror.ts`, `state-mirror.test.ts`). |
| [#91](https://github.com/palmier-io/palmier-pro/issues/91) | Captions: timing drift + no words-per-caption control | Planned | No caption subsystem. The lesson to carry over: snap caption phrases to real word timestamps rather than distributing by character count. |
| [#97](https://github.com/palmier-io/palmier-pro/issues/97) | Chroma key (green-screen removal) | Planned | The compositor has blend modes and opacity but no per-clip effect stack. Should land through the shared preview/export effect registry, not as a compositor special case. |
| [#107](https://github.com/palmier-io/palmier-pro/issues/107) | Video preview stops every time Claude sends an MCP command | Implemented | Agent and MCP edits arrive as `editor:apply-from-main`, are adopted as one undoable step, and the resulting project revision requests a fresh composite at the current playhead; per-window generations stop a stale async frame from replacing newer output. The preview is not torn down or paused by a tool call. |
| [#117](https://github.com/palmier-io/palmier-pro/issues/117) | Evaluate and Install palmier-pro | N/A platform | A macOS install/evaluation thread. Windows installation is a different mechanism entirely (NSIS and portable builds), documented in `README.md`. |
| [#118](https://github.com/palmier-io/palmier-pro/issues/118) | AI content labels for media assets | Planned | `MediaAsset` carries technical probe metadata only, with no tag or description fields and no media index to search them. |
| [#122](https://github.com/palmier-io/palmier-pro/issues/122) | Expose MCP server to local network | N/A platform | Not applicable as built: `PalmierMcpServer` uses `StdioServerTransport`, so there is no listening socket to expose or to secure. If an HTTP transport is ever added it must be loopback-bound by default and require a bearer token — the same conclusion upstream reached. |
| [#137](https://github.com/palmier-io/palmier-pro/issues/137) | Support multiple concurrent Palmier tabs/sessions | Planned | `main/application.ts` owns a single `mainWindow`, and the main-process `EditorController` mirror plus the MCP server are process-wide singletons. Multi-session needs per-window controller identity and session routing on the MCP surface first. |
| [#140](https://github.com/palmier-io/palmier-pro/issues/140) | Multi-provider LLM support (DeepSeek, custom OpenAI-compatible APIs) | Implemented | `main/ai/openai-compatible.ts` speaks `/chat/completions` with tool calling over `fetch`, no vendor SDK added. Presets cover OpenAI, OpenRouter, Groq, Together, Ollama, and LM Studio, plus a custom endpoint. The same `ToolExecutor` runs regardless of provider. `openai-compatible.test.ts`, `agent.openai-compatible.test.ts`. |
| [#141](https://github.com/palmier-io/palmier-pro/issues/141) | `{"code":"... Server Error"}` | N/A platform | An error from upstream's hosted chat backend. This port is bring-your-own-key with no Palmier-operated service in the request path. |
| [#142](https://github.com/palmier-io/palmier-pro/issues/142) | Add Codex CLI agent provider | Planned | The provider registry added for #17/#140 covers HTTP endpoints only. A CLI-subprocess provider is a different transport (spawn, stream, sandbox the working directory) and is not implemented. |
| [#154](https://github.com/palmier-io/palmier-pro/issues/154) | XML import/export for professional NLE compatibility | Planned | No interchange layer. Tracked jointly with #289 in the parity ledger. |
| [#155](https://github.com/palmier-io/palmier-pro/issues/155) | Compound clips (nested sequences) | Planned | The project model has a single flat timeline; a clip cannot reference another timeline. Needs a nested-sequence type plus recursive preview and export resolution. |
| [#156](https://github.com/palmier-io/palmier-pro/issues/156) | Library / Event / Project hierarchy | Planned | Projects are single files opened individually; there is no library container or browser. |
| [#157](https://github.com/palmier-io/palmier-pro/issues/157) | Named presets for color grading and shot settings | Planned | Depends on the missing effect stack (#97) — there are no grading parameters to name or reuse. |
| [#158](https://github.com/palmier-io/palmier-pro/issues/158) | Audio editing tools beyond volume control | Planned | Audio support is clip placement, fades, linked A/V, and silence detection. No EQ, compression, or gain automation. |
| [#164](https://github.com/palmier-io/palmier-pro/issues/164) | Keyboard shortcuts for common editing actions (Premiere/Resolve parity) | Implemented | `shared/editor/shortcuts.ts` is a declarative catalogue with strict modifier matching and a conflict test; the handler dispatches on command id with a compile-time exhaustiveness guard, so an unbound command fails the build. Adds edit-point navigation, mark navigation, snapping, fit-to-window, project I/O, and guide toggles, and a generated shortcut sheet (F1 or `?`). `shortcuts.test.ts`, `edit-points.test.ts`, `timeline-navigation.test.ts`. |
| [#165](https://github.com/palmier-io/palmier-pro/issues/165) | Noise reduction for audio clips | Planned | Same missing effect stack as #97, on the audio side. |
| [#166](https://github.com/palmier-io/palmier-pro/issues/166) | Preview ignores aspect ratio; move export to a dedicated workspace panel | Implemented | The aspect-ratio half: the preview reads the live canvas from project settings and resizes with it, and the compositor composites at the project canvas. The panel half: export docks as a right-hand workspace column riding the persisted panel flags (fourth `PanelKey`, title-bar toggle with active state, Ctrl+M, Escape), with mount-scoped effects and live event subscriptions — settings adjust between renders, which a modal could not do. Also fixed en route: a verbatim-duplicated captions checkbox block. |
| [#167](https://github.com/palmier-io/palmier-pro/issues/167) | Viewer guides for the preview canvas | Implemented | `shared/preview/guides.ts` holds normalized geometry for a centre cross, thirds, a grid, and SMPTE action/title safe areas, with the cross aspect-corrected so its arms stay square on any canvas. `GuideOverlay` draws it as a non-interactive SVG above the canvas; it is never part of compositor or exporter input, so guides cannot be baked into an export. Toggles live in the preview toolbar and on `G` / `Shift+G`. `guides.test.ts`, `ui-guides.test.ts`. |
| [#173](https://github.com/palmier-io/palmier-pro/issues/173) | Google sign-in stalls on macOS 26 | N/A platform | Depends on Clerk and `ASWebAuthenticationSession`. This port has no account system or OAuth flow; keys are user-supplied and stored via DPAPI. |
| [#174](https://github.com/palmier-io/palmier-pro/issues/174) | Auto Remove Silence: detect and ripple-delete silent regions | Implemented | On-device RMS envelope detection (FFmpeg feed into a pure `SilenceDetector`), ripple close through a snapshot-undoable `ReplaceClipsCommand`, plus Inspector and `remove_silence` agent paths, both resolving the same saved Minimum Pause / Speech Padding / Threshold controls (PR #426). `silence-detector.test.ts`, `remove-silence.test.ts`, `silence-settings.test.ts`, `executor.silence.test.ts`. |
| [#195](https://github.com/palmier-io/palmier-pro/issues/195) | Request for Windows Support | Implemented | The purpose of this repository. x64 portable plus x64/arm64 NSIS installers. |
| [#211](https://github.com/palmier-io/palmier-pro/issues/211) | Support auto save on change | Implemented | Debounced crash-recovery autosave writes an atomic snapshot through the serialized project writer and is cleared on a clean explicit save. `useAutosave`, `main/ipc/autosave.ts`, `project-writer.test.ts`. |
| [#212](https://github.com/palmier-io/palmier-pro/issues/212) | Playback speed beyond 0.25x | Implemented | `shared/editor/playback-rate.ts` owns the presets (0.25x through 10x), normalizes any rate at the store boundary so a non-finite value cannot poison the frame accumulator, and centralizes J/K/L shuttle behavior. The playback loop also clamps catch-up to 250 ms so returning from a background tab cannot trigger a thousand-iteration render burst. `playback-rate.test.ts`. |
| [#222](https://github.com/palmier-io/palmier-pro/issues/222) | Intel Mac: "incorrect executable format" (binary is arm64-only) | N/A platform | A Mach-O fat-binary packaging problem. Windows publishes separate x64 and arm64 artifacts. |
| [#252](https://github.com/palmier-io/palmier-pro/issues/252) | Sharing an idea for caption transcription | Planned | Depends on the absent transcription and caption subsystems (#39, #91). |
| [#262](https://github.com/palmier-io/palmier-pro/issues/262) | Windows help | Implemented | Same request as #195; this port is the answer. |
| [#264](https://github.com/palmier-io/palmier-pro/issues/264) | Agent crash: out-of-range integer frame arg traps Int arithmetic | Implemented | Frame arguments are validated at the Zod boundary (finite, integer, within `[0, MAX_FRAME]`), clamped again in `ToolExecutor`, and guarded in `EditorController` via `clampFrame`/`asValidFrame`. `safe-number.test.ts`, `controller.overflow.test.ts` including the upstream `1e19` repro. |
| [#286](https://github.com/palmier-io/palmier-pro/issues/286) | Ability to restructure parts | Partial | The request is workspace layout, in CapCut's terms: rearrange the panels, detach the chat into its own window, or reduce the view to just the timeline and video. Nothing here is platform-specific, so it applies in full, and two of the three now work. Hiding panels already worked from the title bar, and that layout is persisted, so "only the timeline and video in view" survives a restart instead of resetting on every launch. Stored flags are narrowed on read, and a panel the saved layout does not mention falls back to its default, so a layout written by a build with a different set of panels still loads. Rearranging arrived with the named presets adopted from PR #430 — `default`, `media` and `vertical`, on `Ctrl+1/2/3` — which is the shape upstream chose over free-form dragging and the one that actually answers the vertical-video case. Missing: grouping panels as tabs, detaching one into a separate window, and resizable splitters with remembered divider positions. `shared/ui/workspace-layout.ts`, `store/ui.ts`, `ui-panels.test.ts`, `ui-layout.test.ts`. |
| [#287](https://github.com/palmier-io/palmier-pro/issues/287) | Custom STT | Planned | Requires the transcription subsystem (#39) plus a pluggable STT provider, neither of which exists. |
| [#289](https://github.com/palmier-io/palmier-pro/issues/289) | XML imports and exports | Planned | Duplicate of #154 in substance; tracked as one interchange work item. |
| [#302](https://github.com/palmier-io/palmier-pro/issues/302) | Local MCP batch reel production: headless/stability + `manage_tracks` mis-targeting | Partial | The mis-targeting half is now closed on this port too: the `manage_tracks` tool (upstream PR #520's surface) addresses every entry by stable track id or current index — exactly one, never both — so a stale index cannot retarget an edit. Stability is covered by the #58 row. Missing: a headless or windowless mode — the MCP server currently requires the Electron app to be running with a window. |
| [#310](https://github.com/palmier-io/palmier-pro/issues/310) | Hermes / Herm MCP client integration | Planned | The stdio MCP server is client-agnostic and `generateMcpConfig` emits a launch config, so a compliant client can already attach. No Hermes-specific config generation, install flow, or verification exists. |
| [#453](https://github.com/palmier-io/palmier-pro/issues/453) | Media import silently drops files, no error shown | Implemented | Closed on this port with both gaps fixed. `main/media/import-expansion.ts` expands a dropped folder recursively — depth ≤ 8 (matching the relink walk), a 500-file ceiling that appends one truncation notice, symlinks never followed so junction cycles terminate by rule — and imports the supported media inside, where before the directory itself was refused as "not a supported media file" because it has no media extension. A folder that cannot be listed reports `Could not read folder X`; unsupported files *inside* an expanded folder are ignored quietly (sidecars like `.srt`/`thumbs.db` are not failures) while top-level unsupported drops keep their named refusal; explicitly picked files import even after a folder hit the ceiling. `shared/media/import-summary.ts` renders the full skip list (first three reasons + `(+N more)`) in both the media panel banner and the timeline drop toast, replacing the old `errors[0]`-only display. `import-expansion.test.ts`, `import-summary.test.ts`. |
| [#464](https://github.com/palmier-io/palmier-pro/issues/464) | Please support Apple account login | N/A platform | Same family as #173: Sign in with Apple depends on `ASWebAuthenticationSession` and Apple's hosted OAuth endpoints. This port has no account system; API keys are user-supplied. |
| [#484](https://github.com/palmier-io/palmier-pro/issues/484) | Add Antigravity CLI integration via MCP | Partial | The stdio MCP server (`main/ai/mcp-server.ts`) is client-agnostic standard MCP and `generateMcpConfig` emits a launch config, so a compliant CLI can attach today — the same position as the Hermes request (#310). No Antigravity-specific config generation or verified walkthrough exists yet. |
| [#516](https://github.com/palmier-io/palmier-pro/issues/516) | A more clear way to find the manual editing tools | Planned | Discoverability of manual tools versus the Agent. Applies here in full; the shortcut sheet (F1) covers keyboard discovery but there is no toolbar affordance inventory or guided tour (upstream's answer is the #458 onboarding flow). |
| [#527](https://github.com/palmier-io/palmier-pro/issues/527) | Not working for macOS Sequoia | N/A platform | A macOS 15 compatibility report against an app whose minimum is macOS 26. The Windows support floor is set by Electron, not by an Apple OS version. |
| [#532](https://github.com/palmier-io/palmier-pro/issues/532) | Migrate MCP server to the 2026-07-28 stateless protocol | Planned | Relevant: `main/ai/mcp-server.ts` implements stdio MCP and would need the stateless HTTP transport to serve remote/CLI clients without a persistent session. Tracked with the headless-mode gap under #302. |
| [#536](https://github.com/palmier-io/palmier-pro/issues/536) | v0.7.4 regression of #465: scrub decode blocks on the tokio blocking pool | N/A platform | Scrub audio does not exist on Windows (#418 disposition); playhead scrubbing is visual only, so neither the original defect nor this regression can occur. The transferable rule — decode work must stay off the interaction path — is already enforced by process separation and `latest-request.ts`. |
| [#556](https://github.com/palmier-io/palmier-pro/issues/556) | Playback can take 50+ seconds to start on sparse timelines with many tracks | Implemented | Profiled and fixed. The Windows analogue of upstream's per-frame build cost was real: the compositor's visible-layer scan did a track-list `find` per clip in its filter and **two** per sort comparison, so every composite and prefetch request paid O(clips × tracks) even when the tracks were empty at that frame. `main/media/visible-clips.ts` now builds one track index per call and resolves ordering keys before sorting — O(clips + tracks), same semantics (audio exclusion, hidden tracks, half-open range, track-order layering). Measured over 120 resolutions on a 40-track / 3000-clip timeline: worst-case placement 120.9 ms → 8.65 ms (**14×**, and no longer growing with track count); typical placement 2×. The per-pass media lookup got the same treatment (one index instead of a scan per clip). The absolute stall upstream reports never reproduced here — bounded decode pool and newest-wins coalescing cap the rest — so this closes as hardening with a scaling regression guard (`visible-clips.test.ts`). |

## Implementation notes

Detailed notes for adopted work. Older entries are retained for provenance.

### #68 — source fps versus timeline fps

`MediaAsset.duration`, `Clip.inPoint`, `Clip.outPoint`, and `Clip.durationFrames`
are all stored in **project** frames. The preview previously converted a
project-frame offset into seconds by dividing by the *asset* fps, so a 60 fps
source in a 30 fps timeline sought to half the intended time, and a 24 fps source
overshot by 1.25x — far enough on a long clip to seek past EOF, which made FFmpeg
scan the file until the five-second timeout and presented as a hang.

The fix introduces one shared model (`shared/media/source-time.ts`) and removes
the ambiguity at the interface: `DecodeRequest` now carries `sourceSeconds`
rather than a frame index plus an fps to interpret it with. The cache key
includes the asset, the output dimensions, and the millisecond source time, which
also closes a cross-size collision that became reachable once project resolution
could change. Out-of-range seeks are rejected before FFmpeg is spawned, and the
exporter inserts `fps=<project fps>` ahead of each overlay so sources are
resampled to the project timebase rather than queueing extra frames.

### #164 — keyboard shortcuts

Bindings live in data, not in a switch statement. `shortcutConflicts()` is
asserted empty by a test, so two commands can never silently claim one chord, and
matching is strict about modifiers — `C` razors but `Ctrl+C` is left alone, which
a test pins down for `Ctrl+C/V/X/F/P/W/R/T`. The handler dispatches on command id
through a `switch` with a `never` exhaustiveness guard, so adding a command
without handling it fails the build instead of shipping a dead key.

Two incidental fixes came out of it: `End` landed in the timeline's trailing
padding rather than on the last frame of material, and `fitToWindow` was not
clamped to the viewport's zoom ceiling. Fit-to-window also needed a real width —
the timeline panel now publishes its measured lane width to the store, because
neither the toolbar nor the keyboard layer can see that element.

### #167 — viewer guides

Geometry is normalized to the unit square, so one set of numbers serves any
project resolution and the scaled-to-fit preview. The centre cross is the
exception: its arm length is taken from the shorter edge and converted per axis,
or it would stretch with the aspect ratio. Guides are drawn by the renderer above
the canvas and are deliberately absent from compositor and exporter input.

### #17 / #140 — provider configuration

The base URL is the security-relevant field, since it decides where an API key
and the project's timeline structure are sent. `validateBaseUrl` rejects
non-`http(s)` schemes, credentials embedded in the URL, a query string or
fragment on a base URL, and plaintext HTTP to anything that is not a loopback
address. Loopback HTTP is allowed because local runtimes cannot present a
certificate and their traffic never leaves the machine — refusing it would rule
out the main reason to configure a custom endpoint at all. Validation runs in the
main process as well as the form, because the renderer is not the only thing that
can reach the IPC channel, and the persisted config file is user-writable.

The settings panel states which category the configured endpoint falls into
before the assistant is used.

### #89 — fire-and-forget promises

Made a build constraint rather than a one-time sweep. Beyond marking intentional
detached work, two real defects surfaced:

- `ProjectStore.save()` ignored `result.success`, so a failed write left the
  project dirty while the caller proceeded as though it had been saved. It now
  rejects, and `Ctrl+S` surfaces the failure.
- `useEditorSync` recorded a snapshot as mirrored *before* the IPC call resolved.
  One transient failure therefore left the main-process controller holding a
  stale project while the renderer believed it was current — and because the
  dedupe check then matched, that snapshot was never retried. The Agent and MCP
  server read that controller, so the visible symptom was tools acting on a stale
  timeline. `StateMirror` now records a snapshot only after the peer confirms it.

Silent catches that remain are the genuinely ignorable ones — best-effort temp
file cleanup, audio-context teardown, prefetch misses — and each states why.
Sustained preview composite failures are now reported once per outage instead of
being dropped at frame rate.

### Earlier adopted work

| Upstream | Windows status |
|---|---|
| [#200](https://github.com/palmier-io/palmier-pro/issues/200) | Fixed with #264 above; same validation chain. |
| [#182](https://github.com/palmier-io/palmier-pro/issues/182) | Fixed. The exporter no longer trusts exit code 0 — it stats the output and reports `export:error` on a missing or zero-byte file. |
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
- Chroma key, noise reduction, and named grading presets — all blocked on a
  shared effect stack (#97, #165, #157).
- Compound clips (#155) and a Library/Event/Project hierarchy (#156).
- 10-bit HDR export (#59).
- Optional cloud video understanding and AI media labels (#118).
- A Codex CLI agent provider (#142) and Hermes MCP client integration (#310).

---

_Last reconciled with the parity workflow: 2026-08-21._
