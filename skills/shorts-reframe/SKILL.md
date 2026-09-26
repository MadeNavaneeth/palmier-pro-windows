---
name: shorts-reframe
description: Reframe a landscape timeline for 9:16 vertical shorts: switch canvas, center-crop each clip, check framing, then verify and export.
---

# Shorts reframe

Convert a finished landscape timeline into a vertical 9:16 short using only
the editor's own canvas and crop tools. Look at the footage before and after
cropping; never guess where the subject is.

## Tools

- `get_timeline`
- `get_media`
- `inspect_frame`
- `update_plan`
- `set_project_settings`
- `set_clip_crop`
- `verify_timeline`
- `export_project`

## Workflow

1. Announce the plan with `update_plan`: inspect, switch canvas, crop, check framing, verify, export.
2. Read `get_timeline` so every later call names real clip ids, and use `inspect_frame` on the key clips (`assetId` plus `atSeconds`) to actually see the subject before touching anything.
3. Switch the canvas with `set_project_settings` and `aspectRatio: "9:16"`. This preserves the current short-edge resolution and re-fits existing clips automatically; it is one undoable step.
4. Center-crop each visual clip with `set_clip_crop`: `left` / `right` / `top` / `bottom` are fractions of the source frame, 0-0.45 per edge, applied before position and scale. Crop the empty sides and keep the subject; passing all zeros clears the crop.
5. Re-check framing with `inspect_frame` on the cropped clips. If the subject drifts between cuts, adjust per clip rather than settling for one compromise crop.
6. Run `verify_timeline` and fix what it reports before telling the user the edit is done.
7. Render with `export_project`: `outputPath` must be absolute and its parent folder must already exist.

## Notes

- This skill is advisory text only. It cannot run anything by itself; each step above is a tool call you choose to make.
- Never invent tools or parameters. If an effect the user asked for (tracking, blur background, captions) is not listed under Tools, say so instead of guessing.
- One user action stays one undo step: batch related edits per tool call rather than splitting them across turns.
