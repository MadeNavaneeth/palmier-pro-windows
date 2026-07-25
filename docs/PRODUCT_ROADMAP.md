# Palmier Pro Windows Product Roadmap

## Product Direction

Palmier Pro Windows should become an AI-native professional non-linear editor
for solo creators and small production teams. The near-term goal is not to
clone every page in Premiere Pro, DaVinci Resolve, or Final Cut Pro. It is to
make the core edit dependable, keep the upstream Palmier interaction model
recognizable, and add automation where it removes repetitive work.

The macOS upstream repository remains the product and interaction reference.
This roadmap adds Windows-specific implementation choices and a deliberate
feature order. Before starting a roadmap item, follow
[`UPSTREAM_PARITY.md`](./UPSTREAM_PARITY.md), run `npm run upstream:audit`, and
inspect the corresponding upstream implementation and tests.

## Product Principles

1. **The edit must remain trustworthy.** Manual editing, undo/redo, preview,
   save/recovery, and export correctness have priority over new AI features.
2. **Keep one editing model.** UI, Agent, and MCP call the same validated,
   undoable `EditorController` commands.
3. **Keep one render contract.** Preview and export interpret transforms,
   effects, color, transitions, captions, and audio from the same project data.
4. **Use AI as an assistant, not hidden state.** AI proposes or performs named
   commands that can be previewed, inspected, cancelled, and undone.
5. **Preserve the upstream workspace.** New capabilities go into existing
   panels and inspectors instead of adding permanent toolbars and floating
   panels.
6. **Work offline where practical.** Core editing never requires an account.
   Local transcription and selected local AI tools should remain available.
7. **Measure before promising performance.** Playback, seeking, export, memory,
   project load, and background-job budgets become release gates.

## Stable UI Map

The following ownership model is a constraint, not a suggestion:

| Workspace area | Owns | New features that belong here |
|---|---|---|
| Top toolbar | Project-wide commands and workspace state | Open/save, undo/redo, workspace switcher, export, background-job status |
| Left panel | Sources and creation workflows | Media, folders, search, captions/transcript, audio library, generation |
| Center viewer | Visual result and direct manipulation | Playback, transform/crop/mask overlays, comparison views, scopes overlay |
| Bottom timeline | Time, sequence structure, and direct editing | Tracks, clips, keyframes, markers, captions, multicam, audio lanes |
| Right inspector | Properties of the current selection | Video, audio, text, color, effects, speed, AI edit parameters |
| Agent drawer | Natural-language orchestration and audit | Plans, tool calls, diffs, approval, progress, undo |
| Modal/drawer | Short, focused workflows | Export, project settings, relink, transcription setup, keyboard shortcuts |

Rules:

- Do not add another permanent side panel.
- Do not put clip properties in the top toolbar.
- Do not duplicate Inspector controls in the Agent drawer.
- Use contextual overlays in the viewer for spatial manipulation.
- Use tabs only for stable peer domains; use accordions for effect stacks.
- Advanced controls remain collapsed until enabled.
- At 1024x680, panels may collapse, but the viewer, transport, and timeline
  must remain usable.

## Competitive Capability Baseline

Current professional editors consistently treat the following as table stakes:

- precise ripple, roll, slip, slide, insert, overwrite, and three-point editing;
- reliable multicam, compound/nested sequences, markers, keyframes, and proxies;
- captions, transcript-based editing, titles, and motion graphics;
- managed color, scopes, LUTs, masks, tracking, stabilization, and chroma key;
- audio meters, mixing, EQ/dynamics, cleanup, loudness, and voice-over;
- background export, hardware acceleration, interchange, relinking, and archive;
- AI-assisted search, masking, speech cleanup, captioning, and reframing.

Palmier should first match the dependable editing core, then differentiate with
an auditable Agent, local-first AI options, semantic media search, and a shared
UI/Agent/MCP command system.

## Delivery Roadmap

### R0 - Reliability And Architecture Gate

This gate must stay green throughout all later work.

- Versioned project schema with tested forward migrations.
- Atomic save, autosave, recovery browser, and damaged-project diagnostics.
- Integer/rational timeline time and explicit source timecode.
- One centralized undo history with command coalescing for drag operations.
- Background job manager with queueing, cancellation, progress, retry, and logs.
- Media-offline state, relink workflow, and missing-font/effect warnings.
- GPU capability detection and a supported software fallback.
- Preview/export conformance fixtures for transforms, blend modes, transitions,
  alpha, color, captions, and audio.
- Crash reporting and telemetry remain opt-in.
- Dependency lock, software bill of materials, bundled licenses, and AI model
  license metadata.

Exit gate:

- Recovery restores an unsaved project after a forced process termination.
- A 60-minute reference project opens, seeks, saves, reopens, and exports
  without timeline drift.
- Every edit available to Agent/MCP has validation, undo, and an audit label.

### R1 - Complete The Core Edit

This is the first product milestone and the highest priority.

- Selection model: range, marquee, additive, track, and linked selection.
- Edit operations: insert, overwrite, append, replace, lift, extract, ripple
  delete, ripple trim, roll, slip, slide, split, and extend edit.
- Source viewer with In/Out points and three-point editing.
- Linked video/audio placement for Explorer and Media-panel drops.
- Track targeting, locking, mute/solo, visibility, sync lock, and auto track
  creation with predictable compatibility rules.
- Snapping to playhead, edit points, markers, keyframes, and clip boundaries.
- J/L cuts, detach/relink audio, group/ungroup, and sync indicators.
- Markers with names, colors, ranges, comments, and next/previous navigation.
- Compound clips/nested sequences and adjustment clips.
- Clipboard operations and paste attributes with a property checklist.
- Keyboard command registry with searchable remapping and preset import/export.
- Complete waveform, thumbnail, clip-name, and offline-media timeline states.

Exit gate:

- Every edit operation has model tests and undo/redo round-trip tests.
- Explorer drop, Media-panel drop, Agent insertion, and MCP insertion produce
  equivalent project state.
- Ripple operations preserve linked A/V and do not desynchronize other tracks.

### R2 - Playback, Proxies, And Delivery

- Decode queue with bounded workers, cancellation, cache eviction, and stale
  frame protection.
- Proxy generation, attach/detach, proxy/full-resolution switching, and proxy
  status in the Media panel.
- Render cache for expensive effects and timeline regions.
- Dropped-frame indicator and playback quality modes.
- Audio-clock synchronization and stable J/K/L shuttle playback.
- Hardware decode/encode capability detection with visible fallback reasons.
- Export queue that runs outside the renderer process.
- Presets for H.264, H.265, ProRes-compatible intermediates where legally
  available, image sequences, audio-only, and social aspect ratios.
- Custom frame size, frame rate, bitrate/quality, audio, metadata, range, and
  alpha settings.
- Pause/cancel/retry, estimated time, output validation, and reveal-in-Explorer.
- Queue persistence across app restarts.

Exit gate:

- Preview and export match on the conformance suite.
- A failed export cannot corrupt or silently replace the destination.
- A 4K proxy workflow remains interactive on the defined minimum PC.

### R3 - Titles, Captions, And Transcript Editing

- Dedicated caption track with SRT, WebVTT, and ASS import/export.
- Caption creation, split/merge, timing, speaker labels, safe areas, and style
  presets in the existing Captions tab and Text Inspector.
- Offline transcription with model download management and language selection.
- Transcript search, source/timeline transcript modes, and word-level seek.
- Delete transcript text to create normal undoable timeline edits.
- Filler-word, repeated-take, and silence review before removal.
- Caption generation, line breaking, timing cleanup, translation adapter, and
  burn-in or sidecar export.
- Text layers, lower thirds, reusable templates, alignment guides, backgrounds,
  stroke, shadow, and keyframeable properties.

Exit gate:

- Long transcripts remain responsive and can be cancelled/restarted.
- Caption appearance matches in viewer, export, and reopened projects.
- Text-based edits never bypass linked media or ripple rules.

### R4 - Color, Motion, And Effects

- Project/clip color-space metadata, display transform, tone mapping, and LUTs.
- Inspector controls for exposure, contrast, temperature/tint, saturation,
  wheels, curves, secondaries, and copy/paste grading.
- Histogram, waveform, parade, and vectorscope with background computation.
- Keyframe lane with interpolation, easing, navigation, copy/paste, and reset.
- Effect stack with enable/bypass, reorder, rename, presets, and comparison.
- Crop, corner radius/softness, transform, opacity, blend, and compositing.
- Chroma key, masks, feathering, inversion, and tracked masks.
- Motion/object tracking and attach-title/effect workflows.
- Stabilization, lens correction, rolling-shutter correction, and denoise.
- Speed changes, ramps, freeze frames, reverse, frame blending, and optional
  optical-flow interpolation.
- A curated first-party transition/effect library rather than hundreds of
  near-duplicate presets.

Exit gate:

- Color transforms are explicit and do not change after reopening a project.
- Every keyframeable property uses one animation representation.
- Effects fail visibly and bypass safely when GPU support is unavailable.

### R5 - Audio Post

- Sample-accurate audio time beneath the frame-based visual timeline.
- Clip gain, fades, pan, channel mapping, normalization, and waveform gain view.
- Track mixer with meters, mute/solo, buses, automation, and master controls.
- EQ, compressor, limiter, gate, de-esser, high-pass, and loudness analysis.
- Dialogue denoise/enhance, hum removal, room reduction, and click cleanup.
- Music ducking under dialogue with editable automation.
- Beat/onset markers and snap-to-beat editing.
- Voice-over recording with input selection, monitoring, countdown, and takes.
- Loudness targets and true-peak checks for web and broadcast presets.
- High-quality pitch-preserving retiming where licensing permits.

Exit gate:

- Export loudness and peaks match the analysis report within defined tolerance.
- Playback remains synchronized after retiming, sample-rate conversion, and
  long exports.

### R6 - AI-Native Editing

AI features begin only after the commands they use are stable manually.

- Semantic media indexing and natural-language search with local index storage.
- Search by transcript, people/objects, shot type, motion, quality, and metadata.
- Agent plan mode that shows intended commands before destructive multi-step
  edits and produces a before/after timeline summary.
- Rough-cut creation from a brief, transcript, selects, markers, and duration.
- Find best takes, remove pauses/fillers, build multicam cuts, and insert B-roll.
- Smart reframing with editable subject tracking.
- Background/person/object isolation and tracked effect suggestions.
- Dialogue cleanup, caption generation, title suggestions, and social variants.
- Optional image/video/audio generation through provider adapters, with origin
  metadata attached to every generated asset.
- Local/cloud model registry with download size, hardware needs, license,
  privacy, estimated cost, and cancellation.
- Evaluation fixtures for tool selection, command validity, and edit quality.

Exit gate:

- Agent and MCP cannot mutate the project outside validated commands.
- Multi-step edits can be cancelled and undone as one transaction.
- Cloud actions show provider and estimated cost before submission.
- Generated assets retain provenance in the project and export report.

### R7 - Professional Workflows

- Multicam creation, waveform/timecode sync, angle viewer, audio follows video,
  and ripple-safe angle switching.
- OpenTimelineIO boundary plus tested EDL, FCPXML, and supported XML adapters.
- Source timecode, reel/camera metadata, handles, and round-trip reports.
- Consolidate/transcode/archive project with deterministic package writes.
- Relink by hash, filename, metadata, or search location.
- Batch sync, batch rename, metadata columns, ratings, keywords, and smart bins.
- HDR projects, scopes, tone mapping, and 10-bit export where supported.
- Image sequences and professional still formats.
- Project comparison and human-readable change report.
- Review export with burned-in timecode/notes and comment import.

Exit gate:

- Interchange round trips publish a report of preserved, approximated, and
  unsupported data instead of silently dropping information.
- Multicam changes remain synchronized through ripple and undo operations.

### R8 - Extensibility And Release Quality

- Signed Windows installer, unattended install option, repair/uninstall, and
  verified update rollback.
- First-run GPU/media diagnostics and a shareable support report.
- Workspace presets for Editing, Captions, Color, Audio, and Review using the
  same panel system.
- Preset/template packages with version and dependency metadata.
- MCP documentation, command capability discovery, and permission controls.
- Consider OpenFX hosting only after the internal effect ABI and sandbox model
  are stable.
- Consider team collaboration only after deterministic project transactions,
  conflict rules, and media-sharing strategy exist.

## Open-Source Component Strategy

Use focused libraries behind Palmier-owned adapters. Project state, commands,
timeline behavior, and UI remain Palmier code.

| Component | Recommended role | Decision |
|---|---|---|
| FFmpeg/ffprobe | Demux, decode, encode, filters, thumbnails, waveform inputs | Keep as the media foundation; pin the exact build and audit LGPL/GPL options |
| wgpu | Cross-vendor GPU compositing and viewer output | Keep; preview/export shader behavior must share tests |
| OpenTimelineIO | Interchange model and format adapters | Adopt for import/export boundaries, not as live editor state |
| OpenColorIO | Color transforms and industry-standard configuration | Adopt behind a Palmier color service |
| whisper.cpp | Offline transcription | Adopt as the first local transcription backend |
| ONNX Runtime | Portable local inference for segmentation, search, tracking, and enhancement | Adopt through a model registry and bounded worker service |
| OpenCV | Optical flow, classical tracking, stabilization, and image analysis | Adopt selectively in native/background workers |
| libass | Standards-compatible ASS/SSA subtitle rendering | Adopt for captions after preview/export parity tests |
| DeepFilterNet | Local dialogue noise suppression | Prototype; verify model packaging, speed, and quality on the Windows hardware matrix |
| Rubber Band | High-quality time-stretch and pitch shift | Optional only; GPL/commercial licensing must match the distribution decision |
| OpenFX SDK | Third-party video-effect ecosystem | Research for R8; do not host plugins before crash isolation and color contracts exist |
| MLT | Complete NLE engine | Do not embed as a second timeline/render authority |
| GStreamer | General streaming/media pipeline | Do not add to the core editor; reconsider only for live capture/streaming |

Every dependency proposal must include:

- exact source and version;
- source-code and model-weight licenses;
- patent/codec considerations;
- Windows x64 and arm64 availability;
- binary size and startup cost;
- threading/GPU behavior;
- cancellation and crash-isolation design;
- preview/export determinism tests;
- update and vulnerability ownership.

## Features Deliberately Deferred

These are valuable, but building them early would slow the reliable editor:

- a full node-based compositor comparable to Fusion;
- a complete digital audio workstation;
- collaborative cloud project mutation;
- a broad third-party plugin host;
- 3D scene editing and particle simulation;
- mobile companion capture and synchronized live multicam;
- proprietary RAW/codecs without a sustainable licensing plan;
- a stock marketplace or social publishing network.

Use external-tool interchange for these workflows until the editing core and
project format are mature.

## Release Trains

| Train | Included roadmap | User promise |
|---|---|---|
| Foundation Preview | R0 plus the current experimental features behind flags | Projects can be tested without presenting experiments as finished |
| Editing Alpha | R1 | A dependable manual rough-cut editor |
| Creator Beta | R2-R3 | Smooth proxy editing, export, captions, and transcript workflows |
| Studio Beta | R4-R5 | Credible finishing for picture, color, motion, and audio |
| AI Release | R6 | Auditable AI workflows built on the same trusted edit commands |
| Pro Workflow Release | R7 | Multicam, interchange, packaging, HDR, and review workflows |
| Extensible Release | R8 | Installer quality, diagnostics, controlled extensibility |

Roadmap numbers express dependency order, not fixed calendar dates. A train does
not advance because its feature checklist is long; it advances when its exit
gates pass.

## Implementation Progress

### 2026-07-25 - Linked A/V Placement

- Explorer-to-timeline and Media-panel-to-timeline placement now create paired
  audio clips for video assets with probed embedded audio.
- Placement reuses a free, unlocked audio lane and atomically creates one when
  necessary.
- Linked pairs share selection and remain synchronized through move, trim,
  split, delete, undo, and redo.
- Audio clips are excluded from visual preview composition.
- Preview refreshes immediately when a project edit changes at the current
  playhead, including import, Agent/MCP edits, undo, and redo.
- The preload editor command bridge now has matching execute, state, undo, and
  redo handlers in the main process.
- `npm start` produces and launches a production-style local build; named build
  aliases no longer overwrite the runnable Vite main-process bundle.
- Welcome and editor workspaces fit the 1600x1000 and 1024x680 window checks
  without document scrolling.
- Upstream reviewed: PR #353 direct timeline drops, PR #342 linked audio track
  placement, and current `placeClip`/`addClips` linkage behavior.

### 2026-07-25 - Atomic Ripple Delete And Track Controls

- `Shift+Delete` now removes selected and linked clips through one
  `EditorController` transaction instead of issuing separate remove/move
  commands.
- Downstream clips shift once for merged removal ranges; linked A/V remains
  aligned and one undo restores the full operation.
- Sync lock is persisted per track and defaults on for existing and new
  projects. Sync-locked tracks follow ripple edits; disabled tracks stay in
  place.
- Track headers now provide compact icon controls for sync lock, edit lock,
  and video visibility/audio mute without adding another panel.
- Locked tracks refuse delete, ripple, move, trim, and split mutations.
- Hidden video tracks are excluded from both preview compositors, and
  hidden/muted tracks are excluded consistently from both export paths.
- Agent and MCP share the same validated `ripple_delete_clips` command and
  receive a removed/shifted clip report.
- Upstream reviewed: current `RippleEngine`,
  `EditorViewModel+Ripple.rippleDeleteSelectedClips`, and ripple range tests.
- Remaining upstream gaps: ripple range cutting, ripple gap delete, ripple
  trim, and collision refusal diagnostics.

## Definition Of Done For Every Feature

1. Upstream issue, PR, source, and test review is recorded.
2. The UI location follows the stable UI map.
3. The mutation uses a named `EditorController` command or is explicitly
   read-only.
4. Validation, undo/redo, autosave, migration, and offline-media behavior are
   defined.
5. Viewer and export behavior match where applicable.
6. Work runs off the renderer thread when it can block.
7. Progress, cancellation, failure, retry, and cleanup states are visible.
8. Keyboard and accessibility behavior is included.
9. Tests cover the model plus the risky integration path.
10. The 1600x1000, 1024x680, 4K/high-DPI, and long-label UI matrix passes.
11. Performance and memory measurements meet the feature budget.
12. Documentation, attribution, licenses, and the parity ledger are updated.

## Evidence Used For This Roadmap

- [Palmier Pro upstream](https://github.com/palmier-io/palmier-pro)
- [Adobe Premiere features](https://www.adobe.com/products/premiere/features.html)
- [DaVinci Resolve](https://www.blackmagicdesign.com/products/davinciresolve)
- [Final Cut Pro](https://www.apple.com/final-cut-pro/)
- [Descript editor interface](https://help.descript.com/hc/en-us/articles/37585546799757-The-editor-interface)
- [CapCut desktop editor](https://www.capcut.com/tools/video-editing-software)
- [OpenTimelineIO](https://opentimelineio.readthedocs.io/)
- [OpenColorIO](https://opencolorio.org/)
- [ONNX Runtime](https://onnxruntime.ai/docs/)
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp)
- [OpenCV](https://opencv.org/)
- [libass](https://github.com/libass/libass)
- [DeepFilterNet](https://github.com/Rikorose/DeepFilterNet)
- [FFmpeg legal guidance](https://www.ffmpeg.org/legal.html)
