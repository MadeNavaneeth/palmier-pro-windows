/**
 * Title layer rendering, shared by the live preview and the export baker
 * (#525/#529/#530/#519 architecture: docs/TEXT_BAKING_DESIGN.md).
 *
 * One function draws a title clip into any 2D context at project
 * resolution, so preview and baked-export pixels cannot drift apart.
 * Modes beyond solid color render on an offscreen layer:
 *
 * - footage: matte band with the glyphs erased (destination-out), so
 *   overlaying it leaves the footage visible through the letters;
 * - inverted: white glyph silhouette only — the export graph blends it
 *   with `difference`, preview composites it the same way via
 *   globalCompositeOperation='difference';
 * - blur: ctx.filter on every draw, raster effect like upstream's.
 */

import type { Clip } from '../../shared/types/project';
import { TITLE_BACKGROUND_PADDING_DEFAULT, applyTitleFontCase } from '../../shared/editor/title';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface TitleCanvasSize {
  width: number;
  height: number;
}

function makeLayer(width: number, height: number): { canvas: OffscreenCanvas; ctx: Ctx2D } {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
  return { canvas, ctx };
}

/** True when the clip needs the bake pipeline instead of drawtext. */
export function isAdvancedTitle(clip: Clip): boolean {
  return clip.type === 'title'
    && Boolean(clip.text)
    && (clip.titleFillMode !== undefined || (clip.titleBlurRadius ?? 0) > 0);
}

export function drawTitle(
  ctx: Ctx2D,
  clip: Clip,
  settings: TitleCanvasSize,
): void {
  if (!clip.text) return;
  const fontSize = Math.max(
    8,
    Math.round((clip.titleSizeRatio ?? 0.09) * settings.height),
  );
  const weight = clip.titleBold ? 'bold ' : '';
  const family = clip.titleFontFamily || 'system-ui, sans-serif';
  const font = `${weight}${fontSize}px ${family}`;
  const align = clip.titleAlign === 'left' ? 'left' : clip.titleAlign === 'right' ? 'right' : 'center';
  const centerX = clip.x + clip.width / 2;
  const centerY = clip.y + clip.height / 2;

  // Case is applied to the string itself so background measurement, stroke,
  // fill, and drawtext all consume identical glyphs (upstream #330).
  const textLines = applyTitleFontCase(clip.text, clip.titleFontCase).split('\n');
  const lineSpacing = clip.titleLineSpacing ?? 0;
  const lineH = fontSize * 1.2 + lineSpacing;

  const blur = (clip.titleBlurRadius ?? 0) > 0 ? (clip.titleBlurRadius as number) : null;

  const withBlur = (draw: () => void): void => {
    if (blur !== null) ctx.filter = `blur(${blur}px)`;
    draw();
    if (blur !== null) ctx.filter = 'none';
  };

  // ── footage / inverted render on their own layer ──────────────────────────
  if (clip.titleFillMode === 'footage' || clip.titleFillMode === 'inverted') {
    const { canvas: layer, ctx: lctx } = makeLayer(settings.width, settings.height);
    lctx.font = font;
    lctx.textBaseline = 'middle';

    if (clip.titleFillMode === 'footage') {
      // Matte band (upstream forces black when switching to footage), then
      // erase the glyphs so overlaying leaves footage in the letterforms.
      const bg = clip.titleBackgroundColor ?? '#000000';
      let maxW = 0;
      for (const line of textLines) {
        const m = lctx.measureText(line);
        if (m.width > maxW) maxW = m.width;
      }
      const pad = Math.round(clip.titleBackgroundPadding ?? TITLE_BACKGROUND_PADDING_DEFAULT);
      const blockH = textLines.length * fontSize * 1.2 + (textLines.length - 1) * lineSpacing;
      lctx.fillStyle = bg;
      lctx.fillRect(centerX - maxW / 2 - pad, centerY - blockH / 2 - pad, maxW + pad * 2, blockH + pad * 2);
      lctx.globalCompositeOperation = 'destination-out';
      lctx.fillStyle = '#ffffff';
      for (const [i, line] of textLines.entries()) {
        lctx.fillText(line, centerX, centerY + (i - (textLines.length - 1) / 2) * lineH);
      }
    } else {
      // Inverted: opaque white silhouette; the export graph difference-blends
      // it, and preview mirrors that with the same composite operation below.
      lctx.fillStyle = '#ffffff';
      for (const [i, line] of textLines.entries()) {
        lctx.fillText(line, centerX, centerY + (i - (textLines.length - 1) / 2) * lineH);
      }
    }

    withBlur(() => ctx.drawImage(layer, 0, 0));
    return;
  }

  // ── solid color path (unchanged behavior) ─────────────────────────────────
  ctx.save();
  ctx.globalAlpha = clip.opacity;

  // The font must be set before any measureText: the fitted background box
  // has to wrap the same glyphs the fill will draw, or preview and export
  // disagree about the box size (#507).
  ctx.font = font;

  if (clip.titleBackgroundColor) {
    let maxW = 0;
    for (const line of textLines) {
      const m = ctx.measureText(line);
      if (m.width > maxW) maxW = m.width;
    }
    const pad = Math.round(clip.titleBackgroundPadding ?? TITLE_BACKGROUND_PADDING_DEFAULT);
    const blockH = textLines.length * fontSize * 1.2 + (textLines.length - 1) * lineSpacing;
    const boxCenterX = clip.x + clip.width / 2;
    const boxCenterY = clip.y + clip.height / 2;
    ctx.fillStyle = clip.titleBackgroundColor;
    withBlur(() => ctx.fillRect(
      boxCenterX - maxW / 2 - pad,
      boxCenterY - blockH / 2 - pad,
      maxW + pad * 2,
      blockH + pad * 2,
    ));
  }

  ctx.fillStyle = clip.titleColor ?? '#ffffff';
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';

  if (clip.titleStrokeWidth && clip.titleStrokeWidth > 0 && clip.titleStrokeColor) {
    ctx.strokeStyle = clip.titleStrokeColor;
    ctx.lineWidth = clip.titleStrokeWidth * 2; // canvas strokes centered
    ctx.lineJoin = 'round';
    withBlur(() => {
      for (const [i, line] of textLines.entries()) {
        const y = centerY + (i - (textLines.length - 1) / 2) * lineH;
        ctx.strokeText(line, centerX, y);
      }
    });
  }

  for (const [i, line] of textLines.entries()) {
    const y = centerY + (i - (textLines.length - 1) / 2) * lineH;
    withBlur(() => ctx.fillText(line, centerX, y));
  }
  ctx.restore();
}
