# Text Baking Layer — Design for #525 / #529 / #530 / #519

Status: scoped, not implemented. This document pins upstream's exact
semantics from source and defines the architecture that lets the four
remaining advanced title styles work in BOTH render paths under our
FFmpeg exporter.

## Pinned upstream semantics (fetched sources)

From `Models/TextFillMode.swift` and `Compositing/FrameRenderer.swift`
on upstream `main`:

| Mode | Upstream construction | Visual result |
|---|---|---|
| `color` (default, stored as nil) | normal glyph fill | solid styled text |
| `footage` (#525 family, "text stencil" #349) | white-glyph mask over **box + glyphs**; `CIBlendWithMask` picks accumulated frame inside the mask, matte color (`textStyle.color`, forced black when switching to footage) outside | classic caption band: solid matte box with letters knocked out, showing the footage beneath |
| `inverted` | glyphs rendered white with background/border/shadow stripped; RGB zeroed, alpha kept, bias 1 → white silhouette; blended with `.difference` against the frame | footage colors inverted inside glyph shapes |
| blur (#529) | gaussian-blur effect applied to the rendered TEXT RASTER before transform | soft text |
| perspective tilt (#519) | `transform.hasTiltRotation` → `CIPerspectiveTransform` projecting raster corners around the transform center | tilted text |

Key structural fact: all four are whole-layer raster effects computed
AFTER layout, several needing access to the ACCUMULATED frame. No
drawtext parameter can express any of them.

## Chosen architecture: renderer-baked full-canvas RGBA + filter nodes

Every advanced title becomes a full-canvas transparent PNG baked by the
renderer using exactly the drawing code the preview uses, then composited
per clip in the export graph:

| Mode | Bake content | Export node(s) |
|---|---|---|
| footage | matte band with glyphs erased (`destination-out`) | plain `overlay` — footage shows through cut-outs for free |
| inverted | white glyph silhouette (RGB=1, A=coverage) | `[accum][bake]blend=all_mode=difference` |
| blur | styled layer drawn with `ctx.filter='blur(Npx)'` on an offscreen layer | standard `overlay` |
| tilt | untransformed bake; corners projected at build time | FFmpeg `perspective=x0:y0:...` on the baked input before overlay |

Fades reuse the existing pattern: the baked input gets
`fade=t=in/out:alpha=1` windows matching the clip's fade frames before
compositing; `enable=between(...)` gates as today.

## Required pieces

1. **Model** (`shared/types/project.ts`): `titleFillMode?: 'color'|'footage'|'inverted'`,
   `titleBlurRadius?: number`, `titleTiltXDeg?/titleTiltYDeg?: number`
   (none exist yet; Clip has only 2D `rotation`).
2. **Shared draw core**: extract `renderTitleLayer` into a pure
   `drawTitle(ctx, clip, settings)` used by preview-engine AND a new
   renderer baker, so preview/export agreement is structural.
3. **Bake IPC**: renderer bakes each advanced clip to PNG at project
   resolution on export start (ExportPanel already owns the trigger),
   pushes bytes via `export:put-baked-title` into a per-export temp dir;
   options carry `{clipId → path}`. Main never renders pixels; lifecycle
   mirrors the filmstrip/thumbnail caches, cleaned after export.
4. **export-args branch**: advanced clips take the baked path instead of
   their drawtext node; simple titles unchanged. Fallback if a bake file
   is missing: degrade to drawtext `color` styling rather than fail.
5. **Agent surface**: `add_texts`/`set_title_text` gain `fillMode`,
   `blurRadius`, `tiltX`, `tiltY`.

## Effort estimate

Bake IPC + shared draw core + footage/inverted modes + tests ≈ one
session. Blur is small once baking exists. Tilt adds corner-projection
math mirroring `TextTiltGeometry`. Suggested order: footage first
(highest user value, exercises the entire pipeline end to end).
