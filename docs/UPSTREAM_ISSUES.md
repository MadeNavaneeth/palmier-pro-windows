# Upstream Issue Audit

This document tracks every relevant issue reported against the projects we derive
from / compete with, and our status on each. The goal is that defects reported
upstream are **resolved or structurally impossible** in this Windows port.

Sources audited:
- [palmier-io/palmier-pro](https://github.com/palmier-io/palmier-pro) (upstream, macOS)
- [soysebas-reyes/reelmind](https://github.com/soysebas-reyes/reelmind) (competing Windows port)

> ReelMind currently has **zero** reported issues, so there is nothing to mirror
> from it. The list below is derived from Palmier Pro's tracker. Issues that are
> macOS-platform-specific (Apple auth, AVFoundation, Sparkle, Keychain) cannot
> occur in our stack and are marked **N/A by architecture**.

---

## Resolved / preempted in this repo

| Upstream | Title | Severity | Our status |
|----------|-------|----------|------------|
| [#200](https://github.com/palmier-io/palmier-pro/issues/200) | Agent/MCP numeric tool args crash via `Int(Double)` overflow | **Critical (security)** | **Fixed.** All frame args are validated at the Zod boundary (`finite + int + [0, MAX_FRAME]`), clamped again in `ToolExecutor`, and guarded in `EditorController` via `clampFrame`/`asValidFrame`. Tests: `safe-number.test.ts`, `controller.overflow.test.ts` (incl. the exact `1e19` repro). |
| [#182](https://github.com/palmier-io/palmier-pro/issues/182) | Export silently reports success when the file write fails | Medium (data-loss) | **Fixed.** `Exporter` no longer trusts exit code 0 alone — it `fs.stat`s the output and reports `export:error` if the file is missing or zero-byte. |
| [#58](https://github.com/palmier-io/palmier-pro/issues/58) | MCP server / UI freezes during long agent tool runs | Medium | **Mitigated by design.** Editor tool calls are pure, bounded state ops; long-running work (decode, export, generation) already runs as async child processes / background jobs off the IPC reply path. Bounded loops (#200) remove the freeze trigger. |
| [#211](https://github.com/palmier-io/palmier-pro/issues/211) | Lost progress on crash — needs autosave | Medium (data-loss) | **Fixed.** Debounced crash-recovery autosave (`useAutosave` → `project:autosave`) writes an atomic recovery snapshot; cleared on clean save. |
| [#222](https://github.com/palmier-io/palmier-pro/issues/222) · [#195](https://github.com/palmier-io/palmier-pro/issues/195) · [#220](https://github.com/palmier-io/palmier-pro/issues/220) | Intel Mac / Windows / arch gaps | — | **This project is the Windows answer.** Installer builds **x64 + arm64** NSIS targets. |
| [#173](https://github.com/palmier-io/palmier-pro/issues/173) | Google sign-in stalls (Clerk/ASWebAuthenticationSession) | High | **N/A by architecture.** No cloud account or OAuth — bring-your-own-key only, so this failure mode cannot exist. |

---

## Correctness lessons applied (from merged upstream fixes)

These were upstream PRs (not open bugs) whose lessons we bake in so the bug never appears here.

| Upstream | Lesson | Our status |
|----------|--------|------------|
| [#218](https://github.com/palmier-io/palmier-pro/pull/218) | Clips distort on aspect-ratio change; need shared fit math | **Designed in.** A single geometry module (`native/src/geometry.rs`) is shared by preview and export. Aspect-aware refit is tracked for the project-settings change path. |
| [#179](https://github.com/palmier-io/palmier-pro/pull/179) | Clip durations sized at stale FPS (settings applied after duration calc) | **Noted.** When we add auto-match-on-import, settings must be applied *before* deriving frame durations. |
| [#192](https://github.com/palmier-io/palmier-pro/pull/192) | Media manifest restored after window mount → clips flash "offline" | **Noted.** Project/media state must be restored before the preview's first composite. |
| [#180](https://github.com/palmier-io/palmier-pro/pull/180) | Waveform peaks misaligned with audio | **Noted** for the waveform phase (peak-envelope extraction, not duration-based sampling). |
| [#189](https://github.com/palmier-io/palmier-pro/pull/189) | Caption timing drifts vs. word timestamps | **Noted** for the captions phase (snap phrases to real word timings). |
| [#216](https://github.com/palmier-io/palmier-pro/pull/216) · [#219](https://github.com/palmier-io/palmier-pro/pull/219) | Generation/import jobs not recoverable after restart; no progress placeholders | **Partially designed.** Generation cache + job tracking exist; persistent in-flight recovery + import placeholders are tracked for the generation phase. |
| [#188](https://github.com/palmier-io/palmier-pro/pull/188) · [#122](https://github.com/palmier-io/palmier-pro/issues/122) | MCP LAN exposure needs auth | **N/A today / guarded later.** Our MCP server uses **stdio**, not a network socket, so there is no open port. If an HTTP transport is added it must be loopback-only by default with a bearer token. |

---

## Feature parity backlog (upstream features worth porting)

Not defects — capabilities Palmier Pro shipped that we should match over time:

- ~~Per-clip **blend modes** ([#203](https://github.com/palmier-io/palmier-pro/pull/203), [#213](https://github.com/palmier-io/palmier-pro/pull/213))~~ — **Shipped.** 12 W3C separable modes in the wgpu compositor with an exact CPU fallback, inspector dropdown + opacity, and a `set_clip_blend_mode` agent tool (audio rejected).
- ~~**Auto remove silence** ([#175](https://github.com/palmier-io/palmier-pro/pull/175))~~ — **Shipped.** On-device RMS-envelope detection (FFmpeg → pure `SilenceDetector`), ripple-close via a snapshot-undoable `ReplaceClipsCommand`, Inspector "Remove Silence" button, and a `remove_silence` agent tool.
- **Animated / word-timed captions** + max-words-per-caption ([#215](https://github.com/palmier-io/palmier-pro/pull/215), [#202](https://github.com/palmier-io/palmier-pro/pull/202)).
- **Auto remove silence** ([#175](https://github.com/palmier-io/palmier-pro/pull/175)).
- **FCPXML / XMEML interchange** export for Resolve / Final Cut ([#193](https://github.com/palmier-io/palmier-pro/pull/193), [#197](https://github.com/palmier-io/palmier-pro/pull/197)).
- Ripple trim / select-forward / track reorder ([#208](https://github.com/palmier-io/palmier-pro/pull/208), [#210](https://github.com/palmier-io/palmier-pro/pull/210), [#209](https://github.com/palmier-io/palmier-pro/pull/209)).
- Text outline/stroke + caption background ([#190](https://github.com/palmier-io/palmier-pro/pull/190), [#181](https://github.com/palmier-io/palmier-pro/pull/181)).
- **Skills** system and **batch `split_clips`** agent tool ([#199](https://github.com/palmier-io/palmier-pro/pull/199), [#186](https://github.com/palmier-io/palmier-pro/pull/186)).
- Optional cloud video understanding (e.g. TwelveLabs `analyze_video`) ([#198](https://github.com/palmier-io/palmier-pro/pull/198)).
- Playback speeds beyond 0.25x ([#212](https://github.com/palmier-io/palmier-pro/issues/212)).

---

_Last audited: 2026-06-20. Re-run the audit against both trackers before each release._
