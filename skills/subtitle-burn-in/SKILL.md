---
name: subtitle-burn-in
description: Turn speech into burned-in captions: transcribe or import subtitles, place and style caption titles, then verify and export.
---

# Subtitle burn-in

Turn spoken audio into captions that are baked into the exported video, using
only the editor's own transcription and title tools. Titles render in both
preview and export, so what the user sees is what gets burned in.

## Tools

- `get_timeline`
- `get_clips`
- `get_media`
- `update_plan`
- `transcribe_audio`
- `import_srt`
- `import_vtt`
- `add_texts`
- `set_title_text`
- `verify_timeline`
- `export_project`

## Workflow

1. Announce the plan with `update_plan`: find speech, transcribe or import, place captions, style, verify, export.
2. Find the speech with `get_media` (library asset holding the voice) and `get_timeline` (a video track to hold the captions; captions and titles need a video track).
3. Transcribe with `transcribe_audio`: pass the library `assetId`, an optional ISO-639-1 `language` hint, and optional caption-planning controls (`maxWordsPerCue`, `maxCharsPerLine`, `maxLines`, `pauseBreakSec`). The default `auto` engine prefers offline local transcription, then the custom server, then cloud. An explicit `engine` never falls back: it refuses with a setup message instead, so repeat the refusal to the user rather than retrying silently. The result is laid onto a video track as caption clips snapped to word boundaries.
4. When the user supplies a subtitle file instead, use `import_srt` (raw `srtContent`) or `import_vtt` (raw `vttContent`) with the target video `trackId` and an optional `startFrame` (defaults to the playhead). For hand-built captions, use `add_texts` with `trackId`, `startFrame`, `durationFrames`, and `text` per entry.
5. Style the caption clips with `set_title_text`: `fontSize`, `color`, `bold`, `fontFamily`, `backgroundColor` plus padding for the readable box behind the words. Keep styling legible at the export resolution.
6. Run `verify_timeline` — it flags empty titles — and fix what it reports before telling the user the edit is done.
7. Render with `export_project`: `outputPath` must be absolute and its parent folder must already exist. Titles are composited into the render, which is what makes the captions burned in.

## Notes

- This skill is advisory text only. It cannot run anything by itself; each step above is a tool call you choose to make.
- Never invent tools or parameters. Transcription needs a configured engine or key; when it refuses, surface the setup message instead of working around it.
- One user action stays one undo step: batch related edits per tool call rather than splitting them across turns.
