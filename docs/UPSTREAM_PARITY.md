# Upstream Parity Policy

Palmier Pro Windows follows
[palmier-io/palmier-pro](https://github.com/palmier-io/palmier-pro) as its
product, interaction, and correctness reference. The macOS implementation is
not copied file-for-file; its behavior and invariants are translated into the
Windows architecture.

The machine-generated tracker is in
[`UPSTREAM_SNAPSHOT.md`](./UPSTREAM_SNAPSHOT.md).
[`UPSTREAM_ISSUES.md`](./UPSTREAM_ISSUES.md) carries one explicit disposition for
every open upstream issue in that snapshot, plus implementation notes. This file
holds the high-priority ledger, which is deliberately shorter.

## Workflow

Run this before starting nontrivial work:

```bash
npm run upstream:audit
```

Refresh the tracked snapshot when upstream has moved:

```bash
npm run upstream:audit:write
```

Verify that the committed snapshot still matches upstream:

```bash
npm run upstream:audit:check
```

The audit covers:

- the latest upstream `main` commit;
- every currently open upstream issue;
- recently merged upstream pull requests;
- whether the local snapshot is current.

For a specific feature, also inspect the upstream source and tests. Issue and PR
titles are discovery aids, not sufficient implementation specifications.

## Current Baseline

- Upstream repository: `palmier-io/palmier-pro`
- Upstream branch: `main`
- Upstream baseline: `3026f72ed2924c2e6f876ab34ed6854b744407f9`
- Baseline date: 2026-08-19
- Windows audit date: 2026-08-21
- Upstream release at baseline: v0.7.6
- Previous baseline: `8d5648d893c3cd9b71677c5acea44c08b9616f7c` (v0.6.16, 2026-07-31); the v0.7.0–v0.7.6 changes are triaged in the rows below

## High-Priority Parity Ledger

| Upstream | Area | Windows disposition | Windows owner / evidence |
|---|---|---|---|
| #200, #264 | Numeric frame overflow | Implemented | Zod validation, safe frame helpers, overflow regression tests |
| #211 | Crash recovery autosave | Implemented | `useAutosave`, atomic main-process recovery snapshot |
| #174, PR #175 | Remove silence | Implemented | silence detector, undoable replacement, Inspector and Agent paths |
| #98, PRs #203/#213 | Blend modes | Implemented | shared blend model, compositor, Inspector, Agent command |
| PR #353, PR #342 | Explorer/Finder files directly to timeline and linked audio placement | Implemented | Explorer and Media-panel drops share atomic sequential placement; video with probed embedded audio creates a linked audio clip on a free/unlocked lane (or an undoable new lane), and linked selection/move/trim/split/delete stay synchronized |
| PR #373 | Preview refresh after text insertion or timeline mutation | Implemented | Project revisions at the current playhead request a fresh composite immediately; renderer synchronization recomposites and per-window generations prevent stale async frames from replacing newer output |
| PR #397, PR #438 | Multicam ripple synchronization and angle-trim steering | Planned | Multicam domain is not implemented. PR #438 is merged into a stacked branch (`trim/2-trim-clip-tool`) rather than `main`; it narrows the agent's tool description so an ordinary trim request stops being routed to the multicam angle trim. The transferable rule — a specialized tool must be reachable only on explicit intent, never as the default reading of a general request — already holds here because there is no specialized variant to mis-select |
| PR #372 | Large caption workflow responsiveness | Planned | Caption workflow is not implemented |
| PR #371, issue #212 | Preview playback speeds | Implemented | `shared/editor/playback-rate.ts` owns the 0.25x-10x preset list, normalizes every rate at the store boundary so a non-finite value cannot poison the playback frame accumulator, and centralizes J/K/L shuttle stepping. The playback loop clamps catch-up elapsed time to 250 ms, so returning from a backgrounded window cannot trigger a thousand-iteration render burst (`playback-rate.test.ts`) |
| PR #369 | Edge rounding and softness | Planned | Not represented in the Windows clip/compositor contract |
| PR #361, issues #154/#289 | XML/FCPXML interchange and source timecode | Planned | Export interchange layer is not implemented |
| PR #337, PR #422 | Serialized project-package writes | Implemented | `main/services/project-writer.ts` owns one atomic write contract (unique temp file, flush, rename) and a per-destination FIFO queue shared by `project:save` and `project:autosave`; failures are isolated so one bad write neither stalls the queue nor truncates the last good project |
| PR #331 | Centralized undo history | Implemented | Editor controller owns command history shared by renderer and main-process edits |
| Current `RippleEngine` / `EditorViewModel+Ripple` | Ripple editing and sync lock | Partial | Selected-clip, bounded-gap, and arbitrary marked-range ripple deletion plus linked edge ripple trim use shared atomic controller transactions; range cuts merge, split clips with source-offset fidelity, preserve linked A/V and sync-locked tracks, support one-step undo/redo, and are shared by UI/Agent/MCP; source-seconds mapping, temporary sync-lock exemptions, and user-facing refusal diagnostics remain planned |
| PR #346 | Process-wide inference serialization | Different by design | Apple MLX path is absent; Windows generation providers still require bounded job concurrency |
| PR #408 | Invert colors effect | Planned | Windows has no shared effect-stack contract yet; add through the R4 preview/export effect registry rather than a compositor-only special case |
| PR #406 | Source-video preparation and grouped video models | Partial | Windows generation providers and source inputs exist; model capability grouping and shared source preprocessing remain part of the R6 provider registry |
| PR #405 | AVAssetReader teardown off cooperative workers | N/A platform | Windows uses FFmpeg/native decoding rather than AVFoundation; decoder cancellation and teardown remain an R2 performance gate |
| PR #404 | Disable AppKit content-driven panel sizing | N/A platform | Windows uses React/Electron layout constraints; the 1600x1000 and 1024x680 no-scroll matrix covers the analogous regression |
| PR #403 | Unblock main thread when project write throws | Implemented | Writes stay off the renderer interaction path via asynchronous Node filesystem calls; `project:save` validates the payload, writes atomically, and returns the failure to the caller with the previous file intact (`project-writer.test.ts`) |
| PR #401 | Korean README wording | N/A platform | Upstream documentation-only localization change; no translated Windows README currently exists |
| PR #409 | Media browser selection and actions | Implemented | `shared/media-panel/selection.ts` owns the four selection modes, anchor, column-aware arrow navigation, select-all and stale-selection pruning against the visible set; `renderer/store/media-panel.ts` holds the live state and `MediaBin` publishes visible order plus measured column count. Deletion goes through `EditorController.removeMediaAssets`, which removes dependent and linked clips in one undo step and refuses when a dependent clip is on a locked track. Folders, timelines and asset rename have no Windows analogue yet, so those upstream menu entries are out of scope |
| PR #410 | Additional 3x3 / 4x4 grid layouts | Planned | Windows has no multi-clip layout domain at all (no `VideoLayout` analogue, no `apply_layout` tool). The row-major `rNcN` cell addressing and the single shared grid generator are the contract to adopt when layouts land; clip geometry primitives (`x/y/width/height/scaleX/scaleY`) already exist to build on |
| PR #411, PR #415, PR #416 | Seed Audio generation, promptless lip sync, AI video reframing, source-video normalization | Planned | The Windows generation subsystem is still a stub: `generate_media` returns "not yet implemented", providers expose flat `string[]` model lists with no capability metadata, and model choice is smuggled through `request.extra`. All three depend on the same R6 provider registry tracked by PR #406 — model capability grouping, duration limits, reference/source inputs, shared source preprocessing, and billing from source audio — so they are adopted after it, not before |
| PR #417 | Custom project aspect ratios | Implemented | `shared/project/aspect-ratio.ts` parses `width:height`, preserves the current short edge, rounds both edges even, and caps at 8192; `EditorController.applyProjectSettings` applies fps and canvas changes as one undoable edit that rescales every frame-valued field and re-fits clip geometry; `set_project_settings` exposes the same contract to Agent/MCP with upstream's mutual-exclusivity rules, and `get_timeline` now returns the canvas so the agent can read it back. Inspector exposes the presets plus a custom ratio editor. Upstream's parametrized resolution cases are mirrored in `aspect-ratio.test.ts` |
| PR #418 | Disable automatic scrub-audio cache fill | N/A platform | Windows has no scrub-audio engine; playhead scrubbing is visual only. The analogous newest-wins coalescing for frame requests already exists in `main/media/latest-request.ts`. Revisit if scrub audio is implemented |
| PR #419 | Batch bulk clip property mutations | Implemented | `SetClipPropertiesCommand` plus `EditorController.applyClipProperties` resolve every target clip in one pass (`clipIndices`, early exit) and write all changes as one undo step; single-clip setters delegate to the same path, no-op edits add no history entry, ineligible clips are reported rather than silently mutated, and untouched clips are passed through by reference. The Inspector now edits a multi-clip selection instead of refusing it. Upstream's font-resolution caching has no analogue (no text/font model on Windows) |
| PR #420 | Guard live scopes without video tracks | N/A platform | Windows has no live scopes (no histogram, hue histogram or key-hue sampling) and no `AVAssetImageGenerator`. The empty-composition guard becomes relevant only when scopes are built; the existing preview path already returns a transparent frame when no visual clip is present |
| PR #421 | Prevent recursive editor layout | N/A platform | The recursion is in AppKit's `layout()` re-entering itself. Windows layout is React/CSS with no imperative layout pass to re-enter; the 1600x1000 and 1024x680 rendered checks cover the analogous regression |
| PR #423 | Pre-warm the open/save panel service at launch | N/A platform | The cost is a cold XPC handshake with `com.apple.appkit.xpc.openAndSavePanelService`. Electron's `dialog` module has no equivalent out-of-process handshake, so there is nothing to pre-warm |
| PR #424 | Show refunds and failures in project activity | N/A platform | The activity feed reports credit refunds from upstream's hosted generation billing. This port is bring-your-own-key with no credit ledger, so there is nothing to refund or display. Generation *failure* reporting is a real gap, but it belongs to the R6 provider registry (PR #406) rather than to a billing surface |
| PR #425 | Chat telemetry context | Different by design | Upstream attaches provider, model and session context to Sentry/analytics events. This port ships no telemetry or crash reporting; diagnostics stay local. Adopting it would mean introducing outbound analytics, which is a product decision rather than a parity gap |
| PR #426 | Configurable silence removal controls | Partial | The controls are now real and shared. `SILENCE_LIMITS` documents the accepted ranges (minimum pause 0.25-3 s, speech padding 0-0.5 s, matching upstream); `detectSilentRanges` applies speech padding only on a side that actually borders speech, so a run reaching the start or end of the material is removed in full and leading/trailing silence can finally be cut away completely. The Inspector exposes Minimum Pause and Speech Padding as bounded sliders in milliseconds, mirroring upstream's fields, plus Reset. Threshold is an added Windows control with no upstream counterpart: upstream decides silence from an on-device speech mask, while this port measures an RMS envelope, which makes the level itself a user-facing decision. The **main process owns the saved settings** (`main/media/silence-settings.ts`), not the renderer, because `remove_silence` invoked with no arguments must perform the edit the visible controls describe and the Agent and MCP server run there; `resolveSilenceConfig` implements that contract — omitted arguments follow the saved controls, supplied ones override for one call without rewriting them. Both layers are normalized, so a hand-edited settings file cannot govern a removal, and `audio:detect-silence` now rejects a non-string path before it reaches FFmpeg. Settings are preferences rather than project data, so moving a slider is not an undoable document edit. The **scoped-removal half is now ported** (upstream's `clipIds` contract): `shared/editor/silence-scoping.ts` resolves an optional selection with upstream's exact refusal wordings — unknown id named, "must include at least one audio clip", "share one track or belong to one linked A/V unit", audio sources on one track — while omitting scope sweeps every audio track in order; each pass detects once per distinct source file, maps source-seconds onto timeline frames per clip, and cuts through the existing ripple engine so linked partners, sync lock, markers, and undo ride along for free; a missing source refuses before any edit, a locked later track surfaces upstream's partial-success note instead of failing the earlier edits, and receipts echo `sectionsRemoved`/`removedFrames` plus the effective settings (`silence-scoping.test.ts`, `executor.silence.scope.test.ts`; the legacy single-`clipId` form is kept unchanged for compatibility). Missing: scoping to the marked in/out subrange, and timeline shading that previews the removable spans — the latter needs a background speech-mask store and waveform rendering this port does not have yet (`silence-detector.test.ts`, `silence-settings.test.ts`, `executor.silence.test.ts`) |
| PR #428 (open) | Take auditioning: track solo, comping, loop region | Planned | Opened after the recorded baseline, so it is not in the snapshot's merged set. Fully applicable — none of the three exist here. The design constraint worth carrying over is that solo is *derived* state that never rewrites `muted`/`visible`, so un-soloing restores the user's exact setup and undo is unaffected; our `Track.visible` doubles as audio mute, which makes that separation more important, not less. Soloing a video take must follow `linkGroupId` to its audio, which this port already models. Export deliberately ignores solo upstream via a threaded flag; our exporter and preview share compositing rules, so the flag has to reach both or preview and export will disagree |
| PR #429 (open) | Audio track selection for transcripts and captions | Planned | Opened after the recorded baseline. Blocked behind a prerequisite this port does not have: there is no transcription or caption pipeline yet (#39, #91, #252, #287 are all Planned), so there is nothing to target. The transferable part is the argument contract — a positional `trackIndex` validated once and resolved to a stable track id internally — which matches the convention already used here and is the same class of hardening as refusing a clip placement onto an unknown track |
| PR #427 | Provider logos in model menus | Planned | Cosmetic, but it now has a Windows analogue worth having: the AI settings provider list added for #17/#140 is text-only. Needs bundled provider marks with attribution before adoption |
| PR #430 | Appearance settings: workspace layouts, adaptive light mode, timeline clip colors | Partial | The workspace half is adopted. `shared/ui/workspace-layout.ts` is the single definition of the three arrangements upstream ships — `default` (`[Media \| Preview \| Inspector] / [Timeline]`), `media` (media full height down the left, for sifting a large bin) and `vertical` (a tall preview column, which is what makes a 9:16 frame usable instead of letterboxed into a wide box) — together with their labels and the `Ctrl+1/2/3` chords that mirror upstream's `Cmd+1/2/3`. The store, the shortcut catalogue and the title bar switcher all read that one table, so a preset cannot be listed in the menu without a binding or vice versa. The choice is persisted and **narrowed on read**, matching upstream's `flatMap(init(rawValue:)) ?? .default` when loading from `UserDefaults`: a stored preset written by a build that no longer has it must not become the active layout. The Agent panel is deliberately a **sibling column of the preset rather than a member of it**, so switching arrangement never moves or tears down an in-progress chat. Presets stay orthogonal to the #286 visibility toggles — the preset decides where things sit, the toggles decide which of them are present — and a test pins that switching preset does not touch the panel object. One translated difference: upstream *collapses* an `NSSplitViewItem` and the split view hands its space to the remaining siblings, whereas hiding a panel here removes it from the tree, so the `vertical` preset lets the timeline take the whole left column when neither side panel is showing rather than leaving a hole under it. Missing: the adaptive light theme and dark-mode-by-default toggle (this port is dark-only with a warm accent, so a light theme means auditing every token, not adding a switch), customizable timeline clip colors, and resizable splitters with remembered divider positions — upstream gets those from `NSSplitView` autosave names, and they are the same gap #286 still records (`workspace-layout.test.ts`, `ui-layout.test.ts`) |
| PR #440 | Make Swift package development traits opt in | N/A platform | The change makes `BundledSpeech` and `ProductionTelemetry` opt-in Swift Package Manager *traits* so a debug bundle skips compiling the MLX metallib, and forces them on for release. Every moving part is Apple-only: SPM traits, `swift build --traits`, the MLX Metal library, and `.app` bundle resource layout. There is nothing to translate, not merely nothing convenient — this port has no speech or telemetry subsystem to make optional, and its one heavy native component (the Rust/wgpu compositor) is already built by a separate `npm run build:rust` rather than by the renderer build |
| #453 | Media import silently drops files | Implemented | Both reported gaps are closed. `main/media/import-expansion.ts` classifies every dropped path before probing: a directory now expands recursively (depth ≤ 8 like the relink walk, 500-file ceiling with a single truncation notice, symlinks never followed so a junction cycle terminates by rule) and its supported media imports, where before the folder itself was refused as "not a supported media file" and none of its contents imported. A folder that cannot be listed reports `Could not read folder X` instead of vanishing, and explicitly picked files are admitted even after a folder hit the ceiling — the cap bounds expansion work, not the user's own selection. Unsupported files *inside* an expanded folder are ignored quietly (sidecars such as `.srt`/`thumbs.db` are not import failures) while top-level unsupported drops keep the named refusal. `shared/media/import-summary.ts` formats the full skip list for both import surfaces — first three reasons plus `(+N more)` — replacing `errors[0]`, so dropping several unsupported files names all of them (`import-expansion.test.ts`: recursion, bounds, unreadable folder via injected io, link skipping, dedupe; `import-summary.test.ts`) |
| #286 | Restructure the workspace panels | Partial | The request is CapCut-style layout control: rearrange the panels, detach the chat into its own window, or reduce the view to just the timeline and video. Two of the three now work. Panel visibility already existed in the title bar; the layout is persisted in the UI store, so a reduced workspace survives a restart rather than being rebuilt every session, and stored flags are narrowed on read so a panel the saved layout omits falls back to its default. Rearranging arrived with the named presets adopted from PR #430, which is the shape upstream chose over free-form dragging and the one that actually answers the vertical-video case. Missing: tab grouping, detaching a panel into a separate window, and resizable splitters with remembered divider positions (`ui-panels.test.ts`, `ui-layout.test.ts`) |
| #166 | Preview must honour the project aspect ratio | Partial | Preview reads the live canvas from project settings and re-sizes with it, and the compositor composites at the project canvas, so a ratio change is reflected immediately. The second half of the upstream request — moving export into a dedicated workspace panel — is still planned |
| #173 | Apple OAuth stall | N/A platform | No Clerk/ASWebAuthenticationSession path |
| #195, #220, #262, #70 | Windows support | Implemented by project | x64 portable plus x64/arm64 installer targets |
| #68 | Source fps versus timeline fps seek mapping | Implemented | `shared/media/source-time.ts` is the single project-frame-to-source-seconds model. `DecodeRequest` carries `sourceSeconds` instead of a frame index plus an fps to interpret it with, which is what made a 60 fps source in a 30 fps timeline seek to half the intended time and a 24 fps source overshoot past EOF until the decode timeout — the reported "hang". Cache keys include asset, output size, and millisecond source time; out-of-range seeks are rejected before FFmpeg is spawned; the exporter inserts `fps=<project fps>` ahead of each overlay so sources are resampled to the project timebase (`source-time.test.ts`, `frame-decoder.test.ts`) |
| #164 | Keyboard shortcut parity and discoverability | Implemented | `shared/editor/shortcuts.ts` holds the bindings as data with strict modifier matching, and a test asserts no chord is claimed twice and that `Ctrl+C/V/X/F/P/W/R/T` stay unbound. The handler dispatches on command id behind a `never` exhaustiveness guard, so an unhandled command fails the build rather than shipping a dead key. Adds edit-point and mark navigation, snapping, fit-to-window, project I/O, guide toggles, and a shortcut sheet generated from the same catalogue. Fixed along the way: `End` landed in the timeline's trailing padding rather than on the last frame of material, and `fitToWindow` ignored the zoom ceiling (`shortcuts.test.ts`, `edit-points.test.ts`, `timeline-navigation.test.ts`) |
| #167 | Viewer guides for the preview canvas | Implemented | `shared/preview/guides.ts` holds normalized geometry for a centre cross, rule of thirds, a grid, and SMPTE action/title safe areas; the cross arm is derived from the shorter edge and converted per axis so it stays square on any aspect ratio. `GuideOverlay` renders it as a pointer-events-none SVG above the canvas and is never part of compositor or exporter input, so guides cannot be baked into an export. Selection persists through validated local storage (`guides.test.ts`, `ui-guides.test.ts`) |
| #17, #140 | Custom API base URL and OpenAI-compatible providers | Implemented | `shared/ai/provider-config.ts` validates the base URL — rejecting non-`http(s)` schemes, embedded credentials, a query or fragment, and plaintext HTTP to any non-loopback host — and runs in the main process as well as the settings form, because the renderer is not the only caller of the IPC channel and the config file is user-writable. `main/ai/openai-compatible.ts` speaks `/chat/completions` with tool calling over `fetch`, adding no vendor SDK, and runs the same `ToolExecutor` as the Anthropic path. Presets cover OpenAI, OpenRouter, Groq, Together, Ollama, LM Studio, and a custom endpoint; Anthropic gained a gateway override. Both provider loops are capped at `MAX_TOOL_ROUNDS` (`provider-config.test.ts`, `openai-compatible.test.ts`, `agent.openai-compatible.test.ts`) |
| #89 | Fire-and-forget promises | Implemented | Enforced by the type checker rather than audited once: `no-floating-promises`, `no-misused-promises`, and `await-thenable` are errors under a type-aware ESLint config. All 14 pre-existing violations are fixed and intentional detached work is marked `void` with a stated reason. Two real defects surfaced: a failed project save returned normally and looked like a success, and `useEditorSync` recorded a snapshot as mirrored before the IPC call resolved, so one transient failure left the main-process controller the Agent reads holding a stale project with no retry. `shared/editor/state-mirror.ts` now records a snapshot only after the peer confirms it (`state-mirror.test.ts`) |
| #107 | Preview stalls when an MCP command arrives | Implemented | Agent and MCP edits arrive as `editor:apply-from-main`, are adopted as one undoable step, and the resulting project revision requests a fresh composite at the current playhead; per-window generations prevent a stale async frame from replacing newer output. A tool call neither tears down nor pauses the preview |
| #58, #302 | Agent-driven multi-step edit stability | Partial | Editor tools are bounded pure state operations; decode, export, and generation run as separate processes off the IPC reply path; frame requests coalesce newest-wins (`main/media/latest-request.ts`); numeric arguments are range-checked (#264); the agent tool loop is capped at `MAX_TOOL_ROUNDS`. A turn can now be **stopped**: Send becomes Stop while one is running, `ai:cancel` aborts the in-flight request, and both provider paths check the signal between rounds and before each remaining tool call, so a response asking for six edits stops at the one the user interrupted. A tool already executing is allowed to finish, because the executor mutates through undoable commands and tearing one down halfway is how a timeline reaches a state no single undo reverses. Cancelling is reported as a stop, not an error, and clearing the transcript cancels first. **Anthropic history assembly was rebuilt**: a round is now exactly one assistant turn carrying every block the model produced, then one user turn carrying a tool_result for each tool_use in order. The assistant turn used to be appended once per tool and stored by reference, so a response asking for two tools declared both in the first assistant turn while the following user turn answered only the first — which Anthropic rejects, meaning any multi-tool response broke the turn on its next round. That is the shape of failure #58 describes, since a broken round is retried against a conversation that keeps growing. A stopped turn answers the tools it did not run with a cancelled error result rather than leaving them unanswered, and a later message joins the trailing results turn instead of adding a second consecutive user turn, so neither a stop nor the round cap can make every subsequent message fail. A long multi-step turn is covered by a stress suite that pins replayed history to linear growth in the number of rounds — superlinear growth is the mechanism behind the reported stall, because every round re-sends the whole conversation — plus project consistency across dozens of mutations, undoability of the entire run, and clean handling of a run of entirely invalid tool calls. #302's `manage_tracks` mis-targeting has no direct analogue (there is no such tool, and every track-addressing tool takes a stable track id rather than an index, which is the fix upstream landed in PR #307), but the same class of defect existed and is now closed: `addClip` accepted a track id that did not exist, producing a clip invisible to the timeline, the compositor and the exporter while still counting in the clip list, and reporting success to the caller. Missing: a headless mode for batch MCP production (`agent.anthropic.test.ts`, `agent.stress.test.ts`, `agent.openai-compatible.test.ts`, `openai-compatible.test.ts`, `executor.add-clip.test.ts`) |

### v0.7.0 – v0.7.6 triage (baseline moved 2026-08-21)

Rows below cover everything upstream merged between `8d5648d8` and `3026f72e`
(~100 commits, 7 releases). Grouped rather than one row per commit where a
cluster shares a disposition.

| Upstream | Area | Windows disposition | Windows owner / evidence |
|---|---|---|---|
| PR #471 | Preserve omitted OpenAI tool arguments | Implemented | `toOpenAiTools` pins `strict: false` on every function tool, and `parseToolArguments` drops top-level keys sent as explicit `null` before Zod validation — this port's translation of upstream's Responses-API fix, since strict normalization (or a quirk-compatible endpoint) otherwise turns "model omitted this optional" into "explicit null", which every schema reads as a validation failure instead of "use the default" (the `remove_silence` saved-controls contract). Nested objects are untouched; schemas are flat (`openai-compatible.test.ts`) |
| PR #544 | Prevent muted audio from stalling exports | Implemented | Track-level mute was already a build-time exclusion here (the exporter filtered on `track.visible !== false`, matching upstream's fixed invariant), but per-clip `muted` was ignored, so a muted audio clip still reached the export mix at full volume while preview muted it — a preview/export eligibility disagreement in exactly the class #544 fixes. `shared/media/export-eligibility.ts` now owns one list consumed by both the extent calculation and the FFmpeg argument builder: hidden tracks excluded, individually muted audio clips excluded, video unaffected by the audio-only flag (`export-eligibility.test.ts`) |
| PR #486 | Index clip lookups by id | Implemented | The controller resolved ids by linear scan at every mutation entry point (`moveClip`, `trimClipEdge`, `splitClip`, `removeSilence`). A lazily built id→clip map keyed to the exact project object it was built from gives O(1) lookups with reference identity as the invalidation signal — sound because every command, undo, redo, and restore replaces `this.project` wholesale and no path mutates clip objects in place. First occurrence wins per id, matching the `Array.find` it replaced (`controller.clip-index.test.ts`: correctness across mutation/undo/redo/remove/add, no stale identity) |
| PR #488 | Preserve drag access on narrow timeline clips | Implemented | Same defect existed here: 6 px trim zones on clips rendered as narrow as 4 px overlapped and covered the whole body, so short clips could be trimmed but never grabbed to move. `renderer/lib/timeline-clip-hit.ts` owns the rule — below 16 px rendered width the hit zone is always `body` and the visual handles do not render — with the thresholds and zone math unit-tested; `TimelineClip` consumes it. Rendered matrix not re-run for this change: no layout-affecting markup changed, only conditional handle rendering and mousedown routing (`timeline-clip-hit.test.ts`) |
| PR #487 | Batch clip removal in moveClips | Implemented (by construction) | No port needed: `removeClips` filters once per call and `moveClip` rewrites the clips array in a single `.map()` pass; there is no per-clip lookup→mutate→lookup cycle for the upstream fix to remove |
| PR #537 | Prevent full-timeline mutation receipt encoding | Different by design | Mutation receipts here were already shaped summaries ({moved}, {trimmed}, ripple reports) — no code path ever serialized the whole timeline into a tool result, so the defect class is unreachable. `get_timeline` remains the only full dump, by explicit request |
| PRs #542, #560, #552/#551, #504 | Timeline markers + marker review/index surfaces | Partial | The **domain layer is ported and upstream-exact**: `shared/editor/markers.ts` holds the model (`TimelineMarker {id, name ≤120 single line, startFrame, durationFrames (0 = point), #RRGGBB[AA] color defaulting to upstream's blue, comment ≤4000}`), validation, canonical `(startFrame, id)` ordering, fps-rescale, and the ripple engine — a faithful translation of `RippleEngine.rippleMarkers` including its two embedded fixes: empty hole lists do not vote, and surviving positions take the minimum mapped start/end so a marker is never dragged further than one cut requires. `EditorController.changeTimelineMarkers` does create/update/delete mixes as **one undoable step** (`ReplaceMarkersCommand`, whole-array swap like upstream's `registerTimelineMarkerSwap`) with precise thrown errors and no-op calls adding no history entry; all four ripple transactions (`rippleDeleteClips`, `rippleDeleteGap`, `rippleDeleteRanges`, ripple `trimClipEdge`) remap markers in the same transaction, and `applyProjectSettings` rescales them with the timebase. Persistence rides the optional `Timeline.markers` key, so pre-marker projects decode unchanged. The Agent/MCP surface exists: `manage_markers {action: create|update|delete, …}` with per-action argument requirements and no-op receipts, and `get_timeline` now returns markers (`markers.test.ts`, `controller.markers.test.ts`, `controller.marker-ripple.test.ts`, `executor.markers.test.ts`). **The visual surface is implemented**: point markers render as pennant flags and range markers as bands in the ruler (`TimelineRuler`), click selects (Shift additive, dismissing clip/gap selections), drag moves with a local preview and exactly one undo commit per drag, double-click renames inline; `M` adds an auto-named "Marker N" at the playhead (collision-skipping), Delete removes selected markers *before* clips fall through, Escape clears the marker selection, and marker edges are snap targets through `getSnapPoints` — finally giving the reserved `'marker'` snap source its meaning (`timeline-markers.test.ts`). Missing: the full editor popover (color/comment/duration fields — the Agent tool covers them), range-marker creation from the UI, the timeline-index review browser (#552/#504), and the `rippleTimelineMarkers` preference toggle (Windows ripples markers unconditionally, matching upstream's default-on) |
| PRs #535, #539, #540, #541 | Keyframe lanes; animated text size and blur; audio keyframe controls | Planned | No keyframe model exists — clip properties are static scalars. Requires a per-property animation track contract shared by preview, export, and Agent before any of these can land |
| PRs #518, #511, #510, #506, #476, #479, #490, #557, #564, #513 | Captions/transcripts cluster (SRT/VTT import, caption preview, length limits, outline/gap/highlight fixes, transcript-first index, cancellation) | Planned | Blocked behind the absent transcription/caption pipeline (#39, #91, #252, #287). SRT/VTT import (#518) is the least blocked item — it needs only the caption clip model, not transcription |
| PRs #482, #494, #509, #507, #525, #529, #530, #519, #524 | Text styling cluster (default style centralization, preview rebuild preservation, alignment anchoring, fitted boxes, inverted fill, Gaussian blur, stencil mattes, perspective tilt, preset cleanup) | Planned | `ClipType` reserves `title` but there is no text content, font, or rendering model. All nine depend on the text domain landing first |
| PRs #431, #455, #445–#452, #469, #561 | Localization foundation + nine languages + agent chat localization | Planned | Real product behavior upstream (a full i18n stack), not docs. Adopting it means an extraction pass over every user-facing string in renderer and main; deferred as its own workstream, not skipped |
| PRs #563, #470, #472, #531, #457, #501 | Telemetry/Sentry context capture | Different by design | This port ships no telemetry or crash reporting (PR #425 disposition); diagnostics stay local. Nothing to translate without a product decision to add outbound analytics |
| PRs #497, #534 | Community skill sync; in-app skill management | Planned | No skills subsystem exists. #553 (Smart Search model on demand) is N/A platform — it installs an MLX model |
| PRs #456, #458 | Onboarding tour and guided flow | Planned | Product surface, applies in full; sequenced after parity-critical work |
| PRs #498, #481, #499 | FLUX.3 workflows, MiniMax H3 reframe, Fish Audio logo | Planned | Generation provider registry work (PR #406 disposition); `generate_media` is still a stub here |
| PRs #548, #526, #468, #558, #559, #491, #489, #567 | Editor chrome restyling, panel/inspector styling, generation panel docking, media inspector redesign, timeline height, inspector key alignment | Planned (design tracking) | AppKit/SwiftUI styling passes; the Windows analogue is its own Tailwind-token design work against the same rendered-matrix gates, not a translation |
| PRs #465, #474, #536 | Scrub-audio decode off cooperative pools; cancellation race; v0.7.4 regression | N/A platform | No scrub-audio engine; scrubbing is visual only. Process separation plus newest-wins coalescing already enforce the underlying rule off the interaction path |
| PR #475 | Timeline symbol snapshot crash | N/A platform | AppKit custom-bitmap-in-`draw(_:)` crash. Transferable rule recorded: never synthesize tinted bitmaps inside a render pass; use styled-icon APIs (React/Tailwind here) |
| PR #503 | Remove audio meter accessibility polling | N/A platform | No audio meter component exists on Windows |
| PR #538 | Prevent project window transition hangs | N/A platform | AppKit window-transition deadlock; Electron window lifecycle differs structurally |
| PR #545 | Prevent Google sign-in hang | N/A platform | Clerk/OAuth account system absent (#173 family) |
| PR #546 | Reuse source assets during composition builds | Implemented | Both halves of the reuse concern are covered. Preview already deduped decodes through the frame LRU keyed by asset+size+time with concurrent-request coalescing. Export now consolidates too: `main/media/export-args.ts` — the argument builder extracted out of `exporter.ts` into a pure, Electron-free module so it is unit-testable — assigns exactly **one `-i` input per unique source path** in first-use order and remaps every filter chain (`[n:v]trim=…`) and audio `-map` to the consolidated index, where before N clips from one source spawned N full decodes. FFmpeg fans one input out to multiple filter chains, so per-clip trim/scale/overlay semantics are unchanged (`export-args.test.ts`: consolidation, index remapping, canvas-at-0 ordering, muted-audio exclusion interplay, no-addon fallback). The consolidation pass also **closed the long-standing audio-timing gap**: eligible audio clips now build per-clip chains through the same source-time mapping as video (`atrim` + `asetpts`), with timeline-position delay (`adelay`), clip volume (`volume`), and an `amix=normalize=0` mix mapped once as `[aout]` — previously every audio clip exported as a raw full-source stream from time zero regardless of placement. Remaining, inherent to the per-clip-trim filter design: FFmpeg still decodes the shared input once per referencing chain at different offsets; audio fades are not yet an audio-side ramp (the fade fields are visual-opacity semantics in this port) |
| PR #520 | Editable track names + `manage_tracks` | Implemented | Both halves are ported. Naming: `shared/editor/track-name.ts` owns upstream's rules (trim, refuse control characters/newlines, ≤80 chars, empty restores the generated `Video N`/`Audio N` label from the track's position among its type); `EditorController.setTrackName` applies it as one undoable step, refusing invalid or unchanged input without a history entry; the track header renames inline on double-click or via its context menu (`track-name.test.ts`). The Agent surface is upstream-exact: `manage_tracks {reorder?, set?, remove?}` resolves every entry by exactly one of `trackId`/current `index` (the #302 mis-targeting class), applies reorders → sets → removals as **one atomic undoable step**, confines reorder destinations to the track's type zone (orders renumbered per zone so untouched zones keep their exact values and list head stays the top layer), folds `muted`/`hidden` onto this port's single `visible` toggle, treats a present `name: ""` as clear-to-generated with absent meaning untouched, refuses non-empty-track removals and the last of either type, reports `{tracks, reordered?, renamed?, removedTracks?}` receipts, and adds no history for no-ops (`controller.managetracks.test.ts`, `executor.managetracks.test.ts`). Deliberate supersets: `remove` also accepts a bare track-id string, and refusals carry precise reasons |
| PR #512 | Select all clips from track headers | Implemented | The track header context menu selects every clip on the track. Both upstream invariants hold: a missing or empty track returns `false` and leaves the selection untouched, and a successful select clears `selectedGap`, so a following gap-ripple-delete cannot fire against a stale gap (`timeline-selection.test.ts`, including the linked-partner expansion). Upstream's version is UI-only; there is no agent surface to mirror |
| PR #462 | `manage_clip_links` agent tool | Implemented | The domain layer, Agent surface, and UI are all implemented: `EditorController.linkClips`/`unlinkClips` share one `resolveLinkTargets` expansion (requested ids plus their whole current groups) so both directions gate identically, with upstream's exact refusal messages — "at least two clips of different media types that are not already one link group", "None of the provided clips is linked", unknown ids named. Linking stamps a fresh group over the union in one undoable step, which merges two half-groups into one and correctly absorbs auto-created placement groups; unlinking clears the group from the expanded set. The `manage_clip_links {action, clipIds}` tool surfaces domain refusals verbatim to the model (`controller.link-management.test.ts`, `executor.clip-links.test.ts`). The clip context menu carries both manual entries — "Detach audio (unlink)" on any linked clip and "Link selected clips" when the multi-selection spans two media types — reachable on every clip now that the menu no longer requires an audio-bearing source to open at all (the stale Save-as-audio gate used to leave silent video, image, and title clips with no right-click menu, which made mixed selections unlinkable by hand). Menu refusals are swallowed as non-actionable; domain behavior stays under test |
| PR #500 | `swap_clip_media` + armed-swap hardening | Implemented | The domain operation, Agent surface, **and UI arming flow** are implemented. `EditorController.swapClipMedia` keeps every edit-state field intact (timing, trims, geometry, fades), swaps all linked partners sharing the anchor's source in **one undoable step**, and validates with upstream's refusal set translated to this model: title/generated sources cannot swap; the source kind is derived from the current *asset* (this port's rendering of upstream's `sourceClipType` vs `mediaType` split, so an av-pair's audio half validates against video replacements); a silent video cannot back an audio-playing clip (precise message checked before the generic kind mismatch); and a replacement shorter than the trimmed source window is refused rather than clamped. Upstream's trim-end-headroom bookkeeping needs no extra state here — `outPoint` is already free up to the new asset's duration, so surplus footage is extendable in place. The `swap_clip_media {clipId, assetId}` tool reports `{changedClipIds, oldAssetId, newAssetId}`. Deliberate difference: refusals carry precise reasons instead of upstream's generic invalid-replacement wording. The arming flow mirrors upstream's: validation is extracted into `canSwapClipMedia` — the same rules and wordings as a pure dry-run verdict — so "Swap media…" on the clip context menu arms it, the media grid dims every ineligible tile (tooltip = the refusal reason), outlines eligible ones, and a plain click completes the swap through one shared code path; a refused pick keeps the arm with the reason in the panel notice, Escape or the banner button cancels, and the arm pins the clip's edit fingerprint at arm time so an edit that moves/trims/splits/deletes the clip underneath cancels instead of swapping a stale target (verified both live in the clip component and again at completion through the controller, the single authoritative owner) (`controller.swap-media.test.ts`, `executor.swap-media.test.ts`, `media-panel.armed-swap.test.ts`) |
| PR #562 | Extract audio from video into a library asset | Implemented | Both entry points are implemented. The media-panel path extracts the full source; the timeline clip path ("Save as audio" on a clip context menu) bakes the clip's trimmed source window into the file, computed through the same shared mapping export uses (#68) and passed as an output-side `-ss`/`-to` window (decode-then-trim is sample-accurate for a re-encode). Shared machinery: `media:extract-audio` probes first and refuses audio-less sources (upstream's `canExtractAudio` gate), extracts with FFmpeg `-vn -c:a aac` into `userData/extracted-audio` with collision-safe naming, deletes partial output on failure (their embedded cleanup fix), and re-probes; results import through the existing undoable library-import path. Differences from upstream: extraction targets app-owned storage rather than an in-project package (this port keeps media as external paths); the addition is one undoable import step where upstream registers no undo because it is bracketed by package mutation instead; and clip-level speed baking does not apply (no speed model here). Rendered matrix pending for the new menu (`export-eligibility.test.ts`, `timeline-clip-hit.test.ts` cover the neighboring logic) |
| Issue #556 | Playback slow to start on sparse timelines | Implemented | Investigated with a repro, then fixed: the compositor's per-frame layer scan paid O(clips × tracks) (a track `find` per clip in the filter, two per sort comparison). `main/media/visible-clips.ts` resolves layers in one indexed pass — same semantics, O(clips + tracks) — and the per-pass media lookup is indexed too. Measured on 40 tracks / 3000 clips over 120 resolutions: worst-case placement 120.9 ms → 8.65 ms (14×), typical 2×; the cost no longer grows with track count. Upstream's 50-second magnitude never reproduced here (bounded decode pool + newest-wins coalescing); regression guard in `visible-clips.test.ts` |
| Issue #532 | MCP stateless protocol migration | Planned | Relevant to `main/ai/mcp-server.ts` for headless/remote clients; grouped with the #302 headless gap |
| PRs #570, #565, #568 | Generation cost display; inspect-frame grid overlay; static crop in set_clip_properties | Planned | Three small upstream additions. #570 is generation-UI-only (our generate_media is still a stub). #565 requires upstream's inspect_frame tool which this port does not have. #568 adds crop fields to the clip model and compositor -- meaningful but needs its own scoping session alongside the R4 color work. None affect existing functionality |
| PRs #569–#572 | Agent generation model recommendations (Seedance 2.5, GPT Image, Seedream, MiniMax H3) | N/A platform | Agent system prompt text recommending generation models. Our generate_media is still a stub -- these recommendations only apply once the R6 provider registry exists |

This table is deliberately concise. Add rows whenever an upstream change is
adopted, deferred, rejected, or found to expose a Windows regression.

## Change Record Template

Use this block in pull requests or development notes:

```markdown
### Upstream Review

- Baseline: `<upstream commit>`
- Issues/PRs reviewed: `#...`, or `No upstream analogue`
- Disposition: Implemented | Partial | Planned | Different by design | N/A platform
- Windows mapping: `<files and domain owner>`
- Regression coverage: `<tests or manual UI matrix>`
- Remaining gaps: `<explicit list or None>`
```

## Rendered UI Checks

Last run: 2026-08-22, via the committed probe (`npm run ui:probe`) — an
Electron entry that loads the real built renderer with the production preload
and measures layout at each matrix size. The assertion is the overflow
report, not a screenshot.

This closes the earlier gap where no harness was committed; the probe now
runs the gate itself and fails non-zero on any overflow.

| View | 1600x1000 | 1024x680 |
|---|---|---|
| Editor shell (first-run layout) | Fits, scrollX/Y 0, offenders 0 | Fits, scrollX/Y 0, offenders 0 |
| `--text-2xs` token / live element | .625rem / 10px | .625rem / 10px |

This run covers the 2026-08-21 UI batch — track-header context menu and
inline rename (#512, #520), media-panel Extract Audio and notice banner
(#562), clip context-menu Save-as-audio (#562), narrow-clip trim-handle
gating (#488), and the marker ruler layer (#542). Interaction-level probes
(opening menus, dragging markers, mid-turn agent panel) remain manual; the
probe asserts structural layout only.

Historical runs (2026-07-31 and earlier) are preserved below as measured at
the time; later runs supersede earlier numbers rather than rewriting them.

Captured by mounting the real `App` in Electron over a loopback HTTP server and
measuring layout at each target size, rather than by eye. The assertion is the
overflow report, not the screenshot.

Each run below is recorded as it was measured at the time; later runs supersede
earlier numbers rather than rewriting them.

| View | 1600x1000 | 1024x680 |
|---|---|---|
| Editor shell | Fits, no scrollbars | Fits, no scrollbars |
| Shortcut sheet (F1) | 3 columns, 46 chords legible | 3 columns, 46 chords legible |
| Viewer guides | Overlay draws over the canvas | Overlay draws over the canvas |
| Export dialog | Fits | Fits |

Fixed as a result: the timeline toolbar overflowed its panel by 72 px at
1024x680 once the fit-to-window and shortcut-help buttons were added, silently
clipping the rightmost controls. The zoom slider was hidden below a 1200 px
window, where the zoom buttons either side already cover the same ground. That
breakpoint was later found to be measuring the wrong thing — see the third run
below.

The remaining reported inner overflow is the timeline lane and ruler content,
which is deliberately wider than the viewport because the timeline scrolls
horizontally.

Re-run after the Tailwind token repair, because deleting the ignored
`tailwind.config.ts` changed 31 `text-2xs` call sites from the inherited 12 px
down to the intended 10 px, and 24 of those are in the Inspector. The probe now
also reads the computed font size off a live element rather than trusting that
the token exists. All eight view and size combinations still report no document
scrollbars, `--text-2xs` resolves to 10 px, an element using `text-2xs` measures
10 px, the guide overlay still draws, the shortcut sheet still lists 46 chords,
and the console stays clean. The denser type scale introduced no new overflow.

Third run, for the silence controls (PR #426) and the agent Stop button (#58).
Three views at both sizes: Inspector with a video clip selected, every panel open
at once, and the Agent panel mid-turn.

| View | 1600x1000 | 1024x680 |
|---|---|---|
| Inspector silence controls | 3 bounded sliders, `500 ms` / `150 ms` / `-35 dB` | same, sliders 216 px wide |
| All panels open | Fits, toolbar and transport overflow 0 | Fits, toolbar and transport overflow 0 |
| Agent mid-turn | Stop replaces Send, stopped turn tagged | Stop replaces Send, stopped turn tagged |

The all-panels view found a real clipping bug that the earlier runs could not
see, because they never opened the Agent panel. `max-[1200px]:` in the timeline
toolbar and the preview transport row was a **viewport** media query standing in
for a **container** constraint: what decides whether those rows fit is their own
width, which depends on which side panels are open. With the Agent panel open a
1600 px window leaves the centre column about 475 px, so the breakpoints did not
fire, the toolbar overflowed by 26 px and the transport row by 28 px, and the
rightmost controls were clipped out of reach again — the same failure the 1200 px
rule was added to prevent.

Both rows now use container queries (`@container` on the row, `@max-xl:` on the
children), so they respond to the space they actually have. One gotcha: an
element declaring `@container` cannot container-query *itself*, only its
descendants, so the row's own `gap` could not be tightened that way; the last
pixel at the 400 px all-panels-open case was reclaimed on the dividers instead.
Measured slack between the last toolbar control and the panel edge is now about
10 px in every configuration, where it had been -1 px at the narrowest.

All six combinations report no document scrollbars, zero overflow on both rows,
`--text-2xs` at 10 px, Stop present only while a turn is running and Send
otherwise, and no application console errors.

Fourth run, for the persisted panel layout (#286). Four views at both sizes: the
first-run layout, the reduced "timeline and video only" layout, every panel open,
and the Agent panel mid-turn.

| View | 1600x1000 | 1024x680 |
|---|---|---|
| First-run layout | Fits, side panels 480 and 320 px, centre 780 px | Fits, side panels 307 and 240 px, centre 457 px |
| Reduced (#286) | Fits, no side panels, centre 1590 px | Fits, no side panels, centre 1014 px |
| All panels open | Fits, centre 475 px, both rows overflow 0 | Fits, centre 400 px, both rows overflow 0 |
| Agent mid-turn | Stop replaces Send | Stop replaces Send |

The reduced view also confirms the container-query change is measuring the right
thing: at a 1024 px window with no side panels the toolbar is 1014 px wide and
keeps its zoom slider, where the old viewport breakpoint would have hidden it
despite the row having ample room. Each run reads the persisted layout back, so
the assertion covers the round trip rather than only the render.

Fifth run, for the workspace layout presets (PR #430). Seven views at both sizes:
each of the three presets in the first-run panel configuration, the `vertical`
preset reduced to timeline and preview only, `media` and `vertical` with all three
panels open, and the shortcut sheet.

| View | 1600x1000 | 1024x680 |
|---|---|---|
| `default` | Fits, panels 480 / 320, preview 780, timeline 780x270 | Fits, panels 307 / 240, preview 457, timeline 457x270 |
| `media` | Fits, media full height 480x676, preview 780 | Fits, media full height 307x356, preview 457 |
| `vertical` | Fits, preview column 608x951, timeline 977x270 | Fits, preview column 389x631, timeline 620x270 |
| `vertical` reduced | Fits, timeline fills 977x951, preview 608x951 | Fits, timeline fills 620x631, preview 389x631 |
| `media`, all panels | Fits, panels 300 / 480 / 320, preview 475 | Fits, panels 300 / 200 / 200, preview 300 |
| `vertical`, all panels | Fits, panels 300 / 400 / 267, timeline 672x270 | Fits, panels 300 / 200 / 200, timeline 405x270 |
| Shortcut sheet | 3 columns, 40 commands / 49 chords | 3 columns, 40 commands / 49 chords |

All fourteen combinations report no document scrollbars, zero overflow on the
workspace row and on both toolbar rows, every column ending inside the row, the
layout switcher present and reachable with the active preset selected,
`--text-2xs` at 10 px, the persisted preset reading back as the active one, and no
application console errors. Chord count rises from 46 to 49 for `Ctrl+1/2/3`.

This run found a real clipping bug that **predates the presets**, and the reason
the four earlier runs missed it is worth recording: they measured document
scrollbars and the two toolbar rows, but never the workspace row itself. That row
is `overflow-hidden`, so a column that does not fit is clipped rather than
scrolled and never produces a scrollbar to detect. At 1024 px with all three
panels open, media + inspector + a 400 px preview minimum asked for roughly 250 px
more than the row had, and the rightmost panel was simply outside the window — the
fourth run recorded "centre 400 px" for exactly that case without noticing 400 px
was the *minimum* being enforced rather than the space available.

The fix is to stop treating the side panels as rigid. They keep their preferred
viewport-relative widths and now shrink under pressure to a stated 200 px floor;
only the Agent column stays fixed, and it is already at its minimum useful width.
Wrapper columns carry explicit floors rather than a content-derived minimum,
because they contain the timeline, whose min-content width is the full length of
the material. The preview floor is set by its own transport row rather than by
taste — that row needs about 290 px at its narrowest container tier, so a 300 px
floor is the point below which the preview would be narrower than its own
controls; a `@max-sm` tier was added there so the matched side columns collapse to
their content instead of being clipped. The probe now measures the workspace row's
overflow and each column's right edge, so this class of defect fails the check
rather than passing it quietly.

## Release Gate

A release is not parity-audited unless:

1. `npm run upstream:audit:check` passes.
2. Relevant new upstream fixes and features have dispositions.
3. Implemented fixes include appropriate Windows regression coverage.
4. Partial and planned items remain visible in this ledger.
5. Platform exclusions include an architectural reason.
6. UI changes have been checked at 1600x1000 and 1024x680.
