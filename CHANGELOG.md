# Changelog

All notable changes to this project will be documented in this file.

This project follows a lightweight form of Keep a Changelog and uses semantic versioning once releases begin.

## [Unreleased]

### Upstream Review

- Baseline: `457e853a789e16eb104a0bfb43d2485d9e1ac0c8` (upstream v0.6.16; previous
  baseline `de37a5378fe269f4439c20fb88c55365b9d1c4e5`, 22 upstream commits
  reviewed).
- Issues/PRs reviewed: PRs #409, #410, #411, #415, #416, #417, #418, #419, #420,
  #421, #422, #423, #424, #425, #426, #427, and **all 50 open upstream issues**
  in the captured snapshot.
- Dispositions: every open issue now has exactly one explicit disposition in
  `docs/UPSTREAM_ISSUES.md` — 14 Implemented, 3 Partial, 21 Planned,
  11 N/A platform, 1 Needs investigation.
- Newly adopted this pass: #68, #212, #164, #167, #17, #140, #89, and #107.
  Planned for PRs #410, #411, #415, #416, #427; N/A platform for PRs #418, #420,
  #421, #423, #424; Different by design for PR #425 (no telemetry in this port).
- Open upstream pull requests reviewed. Two are newer than the recorded baseline
  and now have dispositions: PR #428 (take auditioning — solo, comping, loop
  region) and PR #429 (audio track selection for transcripts and captions), both
  Planned. Several long-standing open PRs propose features this port already
  reached independently — PR #169 (viewer guides), PR #175 (remove silence),
  PR #265 (bounded frame arguments), PR #108 and PR #187 (keeping preview and MCP
  responsive during agent edits) — so they are tracked through their issues rather
  than as separate work.
- PR #426, #58 and #286 stay Partial but moved substantially: PR #426 gained the
  Inspector controls and the shared saved-settings contract, leaving scoped
  removal and timeline shading; #58 gained turn cancellation, a rebuilt Anthropic
  history assembly, and a long multi-step stress suite, leaving a headless MCP
  mode; #286 gained a persisted panel layout, leaving panel reordering, tab
  grouping and detachable windows.
- #286 moved off `Needs investigation` once the request was read in full: it asks
  for CapCut-style workspace layout control, which applies to this port in full.
  No open issue in the captured snapshot remains under investigation.
- Details and Windows owners are recorded in `docs/UPSTREAM_PARITY.md` and
  `docs/UPSTREAM_ISSUES.md`.

### Added

- Keyboard shortcut parity and discoverability (upstream #164): bindings are now
  declarative data in `shared/editor/shortcuts.ts` with strict modifier matching
  and a test asserting no chord is claimed twice and that `Ctrl+C/V/X/F/P/W/R/T`
  stay unbound. Adds edit-point navigation (Up/Down), mark navigation
  (`Shift+I`/`Shift+O`), mark the selection (`X`), clear marks, select all,
  snapping toggle (`S`), fit timeline to window (`\` or `Ctrl+0`), project
  new/open/save/export (`Ctrl+N/O/S/M`), and a shortcut reference sheet on `F1`
  or `?` generated from the same catalogue. `Ctrl+N` and `Ctrl+O` now confirm
  before discarding unsaved work.
- Viewer guides for the preview canvas (upstream #167): centre cross, rule of
  thirds, a 4x4 grid, and SMPTE action-safe (90%) and title-safe (80%) areas,
  toggled from the preview toolbar or `G` / `Shift+G`. Guides are view-only and
  are never part of compositor or exporter input, so they cannot be baked into an
  export. The selection persists between sessions.
- Custom LLM endpoints and OpenAI-compatible providers (upstream #17 and #140):
  presets for OpenAI, OpenRouter, Groq, Together, Ollama, and LM Studio plus a
  free-form custom endpoint, an editable API base URL and model per provider, and
  an Anthropic gateway override. Base URLs are validated in the main process as
  well as the settings form — non-`http(s)` schemes, embedded credentials, and
  plaintext HTTP to any non-loopback host are rejected. The settings panel states
  whether a configured endpoint sends project data off the machine.
- Quarter-speed playback (upstream #212): `0.25x` joins the preset list, and
  playback rate is normalized at the store boundary.
- Timeline toolbar gains fit-to-window and a keyboard-shortcuts button; snapping
  now reports its state to assistive technology.
- Custom project aspect ratios (upstream #417): shared aspect-ratio model with
  preset and free-form `width:height` ratios that preserve the current short
  edge, an undoable project-settings operation that rescales frame-valued fields
  on a frame-rate change and re-fits clip geometry on a canvas change, a
  `set_project_settings` Agent/MCP tool, and editable resolution / frame rate /
  aspect ratio controls in the Inspector.
- Batched bulk clip property edits (upstream #419): blend mode, opacity, and
  fades can be applied to a whole selection as one undoable operation, and the
  Inspector now edits multi-clip selections instead of refusing them.
- Media browser selection and actions (upstream #409): modifier-aware click
  selection with range and range-extend modes, column-aware arrow-key
  navigation, select-all, and undoable deletion that also removes dependent and
  linked clips.
- Silence removal is now configurable from the Inspector (upstream PR #426).
  Minimum Pause and Speech Padding are bounded sliders in milliseconds, matching
  upstream's fields, alongside a Threshold control this port needs because it
  detects silence from an RMS envelope rather than a speech mask. Previously the
  button ran with hardcoded values, so a pass that cut too much or too little
  could only be undone, not adjusted. The settings are owned by the main process
  and shared with the Agent: `remove_silence` called with no arguments now
  performs the edit the visible controls describe, and any argument it does
  supply overrides for that call only without rewriting the controls.
- An in-flight agent turn can now be stopped (upstream #58). Send becomes Stop
  while a turn is running, and the turn ends between rounds or before the next
  tool call rather than after the model has finished. A tool already executing is
  allowed to complete, because edits go through undoable commands and abandoning
  one halfway can leave the timeline in a state no single undo reverses. A stopped
  turn keeps whatever the model had already said and is labelled as stopped rather
  than reported as an error.
- The panel layout is remembered between sessions (upstream #286). Hiding the
  media, inspector and agent panels already worked, but the choice reset on every
  launch, so working with just the timeline and video in view — which is what the
  request asks for — meant rebuilding the layout each session.
- Contributor guide with development, test, branch, and PR expectations.
- Security policy covering Electron IPC, MCP commands, FFmpeg execution, API-key storage, path validation, and native Rust bindings.
- Issue and pull request templates.
- GitHub Actions CI for TypeScript and Rust checks on Windows.

### Fixed

- Preview and export sought to the wrong time whenever a source's frame rate
  differed from the project's (upstream #68). Project-frame offsets were being
  divided by the *source* frame rate, so a 60 fps clip in a 30 fps timeline
  showed frames from half the intended position, and a 24 fps clip overshot by
  1.25x — far enough on a long clip to seek past the end of file, which made
  FFmpeg scan to EOF until the decode timeout and presented as an export hang.
  Source-time mapping now lives in one shared model, decode requests carry source
  seconds instead of an ambiguous frame index plus frame rate, out-of-range seeks
  are rejected before FFmpeg is spawned, and the exporter resamples each source
  to the project timebase before compositing.
- Silence removal can now cut leading and trailing silence completely (upstream
  PR #426). Speech padding was applied on both sides of every silent span, so a
  clip that began or ended with silence always kept a sliver of it; padding is
  now applied only where the silence actually borders speech. Silence settings
  are also clamped to documented ranges at the Inspector, Agent, and MCP
  boundaries, so a non-finite threshold can no longer report a whole clip silent.
- A failed project save no longer looks like a success (upstream #89). The result
  was previously ignored, leaving the project dirty while the caller carried on;
  `Ctrl+S` now reports the failure.
- A transient renderer-to-main sync failure no longer permanently desynchronizes
  the main-process controller (upstream #89). The snapshot was marked as mirrored
  before the IPC call resolved, and because the deduplication check then matched,
  the failed state was never retried — so Agent and MCP tools could operate on a
  stale timeline indefinitely. A snapshot is now recorded only once main confirms
  it.
- Agent tool loops are bounded (`MAX_TOOL_ROUNDS`). A model that requested a tool
  on every round previously looped without limit, editing the timeline with no
  way to intervene.
- Fitting the timeline to the window no longer exceeds the viewport's maximum
  zoom, and jumping to the end of the timeline lands on the last frame of
  material rather than inside the trailing padding.
- Playback no longer runs a large catch-up loop after the window has been
  backgrounded; elapsed time is clamped to 250 ms per tick.
- Frame cache keys now include the output dimensions, so a project resolution
  change cannot serve a frame decoded at the previous size.
- Sustained preview composite failures are now reported once per outage instead
  of being discarded silently at frame rate.
- Project writes are now serialized per destination and always atomic (upstream
  #337 / #403 / #422). An explicit save and an autosave aimed at the same file
  queue instead of racing, temp files are unique per write, and a failed write
  leaves the previous project on disk instead of truncating it.
- `get_timeline` now returns the project canvas and frame rate it always claimed
  to expose, so an agent can read back what `set_project_settings` changed.
- The app's own typography and animation tokens were never being applied.
  `tailwind.config.ts` defined them, but Tailwind v4 only reads a legacy config
  when a stylesheet asks for it with `@config`, and nothing did — so the file was
  dead. Every `text-2xs` (31 call sites, 24 of them in the Inspector),
  `animate-fade-in`, and `animate-slide-up` silently resolved to nothing and fell
  back to the inherited size. The tokens now live in the stylesheet's `@theme`
  block, which is the one place that is actually read, and small Inspector labels
  render at their intended 10 px.
- Timeline toolbar and preview transport controls no longer get clipped when the
  Agent panel is open. Both rows hid their optional controls below a 1200 px
  *window*, but what decides whether they fit is their own width, which depends on
  which side panels are open: with the Agent panel open, a 1600 px window leaves
  those rows about 475 px wide, the breakpoints never fired, and the rightmost
  controls were pushed out of the panel and out of reach. They now use container
  queries, so they respond to the space they actually have.
- `audio:detect-silence` now rejects a non-string media path before it reaches
  FFmpeg's argument list, and resolves partial settings against the saved controls
  instead of spreading them over the built-in defaults.
- An agent response asking for more than one tool no longer breaks the turn on its
  next round when using Claude (upstream #58). The assistant turn was recorded once
  per tool and stored by reference, so a two-tool response declared both calls in
  the first assistant turn while the following user turn answered only the first.
  Anthropic rejects that, and the failure surfaced a round later as an opaque
  error. A round is now one assistant turn carrying every block the model produced,
  followed by one user turn answering each call in order.
- Stopping an agent turn, or hitting the tool-round limit, no longer breaks every
  later message in that conversation. The turn ended on a user message carrying the
  tool results, and appending the next question after it violated the required role
  alternation. The question now joins that turn, and tools that were not run are
  answered with a cancelled result rather than left unanswered.
- `add_clip` no longer places a clip onto a track that does not exist. The
  controller checked for the track but only used it to decide audio linking, so an
  invented track id produced a clip that the timeline, the compositor and the
  exporter all skip — while it still counted in the clip list and toward the
  project duration, and the caller was told the placement succeeded. The placement
  is refused, and the agent is told which tracks are available.

### Changed

- Floating promises are now a build error (upstream #89). ESLint runs with type
  information and enforces `no-floating-promises`, `no-misused-promises`, and
  `await-thenable`, so detached async work has to be marked `void` deliberately
  rather than omitted by accident.
- Export dialog visibility moved into a shared UI store so the keyboard layer and
  the title bar drive the same state.
- AI provider selection is now a preset id rather than a two-value union, with the
  endpoint and model stored per provider in the main process.
- README status wording now reflects early-alpha functionality and avoids release-ready claims.
- Project plan now separates experimental implementations from released functionality.
- Clearing the agent transcript now stops a turn that is still running, instead of
  letting its answer arrive into an emptied conversation.

### Removed

- `tailwind.config.ts`. It had no effect under Tailwind v4 without a `@config`
  directive, and its palette had diverged from the live theme, so re-attaching it
  would have reverted the current design rather than fixing anything. The tokens
  still in use moved into the stylesheet.
