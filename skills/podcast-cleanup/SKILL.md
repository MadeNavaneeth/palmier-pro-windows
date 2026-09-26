---
name: podcast-cleanup
description: Clean up a spoken-word recording: remove dead air, level loudness, tame EQ and dynamics, then verify and export.
---

# Podcast cleanup

Turn a raw spoken-word timeline into an even, listenable mix using only the
editor's own audio tools. Work through the steps in order; every edit stays a
normal undoable tool call.

## Tools

- `get_timeline`
- `get_clips`
- `get_media`
- `update_plan`
- `remove_silence`
- `normalize_audio`
- `set_clip_eq`
- `set_clip_compressor`
- `verify_timeline`
- `export_project`

## Workflow

1. Announce the plan with `update_plan`: inspect, de-silence, level, EQ, compress, verify, export.
2. Read `get_timeline` (plus `get_clips` / `get_media` as needed) so every later call names real clip ids.
3. Remove dead air with `remove_silence`: pass `clipIds` to scope it to the voice clips, or omit them to sweep every audio track. Pass `thresholdDb`, `minSilenceSeconds`, or `edgePaddingSeconds` only to override the user's saved controls for this call.
4. Level each voice clip with `normalize_audio` (default peak target -3 dBFS; pass `targetDb` only when the user asked for a different peak).
5. Shape tone per clip with `set_clip_eq`: low shelf at 100 Hz, mid bell at 1 kHz, high shelf at 3 kHz, each -15 to +15 dB. Omitted bands stay untouched; pass `clear: true` to reset.
6. Even out dynamics with `set_clip_compressor`: `thresholdDb`, `ratio` (1-20; 1 removes it), `attackMs`, `releaseMs`, `makeupDb`. Omitted fields stay untouched; `clear: true` removes it.
7. Run `verify_timeline` after the destructive batch and fix what it reports before telling the user the edit is done.
8. Render with `export_project`: `outputPath` must be absolute and its parent folder must already exist. Use `format: "audio"` for a podcast M4A mix, or `mp4` when the picture matters.

## Notes

- This skill is advisory text only. It cannot run anything by itself; each step above is a tool call you choose to make.
- Never invent tools or parameters. If a control the user asked for is not listed under Tools, say so instead of guessing.
- One user action stays one undo step: batch related edits per tool call rather than splitting them across turns.
