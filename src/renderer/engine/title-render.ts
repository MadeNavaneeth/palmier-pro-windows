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
import {
  TITLE_BACKGROUND_PADDING_DEFAULT,
  applyTitleFontCase,
  titleTiltCorners,
} from '../../shared/editor/title';

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
    && (
      clip.titleFillMode !== undefined
      || (clip.titleBlurRadius ?? 0) > 0
      || (clip.titleTiltXDeg ?? 0) !== 0
      || (clip.titleTiltYDeg ?? 0) !== 0
    );
}

/**
 * Draw a full-canvas layer onto the target through the projected tilt quad.
 * Canvas 2D has no projective transform, so the layer is composited in
 * horizontal strips whose edges interpolate the four corners — visually
 * faithful for the moderate tilts captions use, and identical between
 * preview and bake because both run this same function.
 */
function drawLayerWithTilt(
  ctx: Ctx2D,
  layer: OffscreenCanvas,
  corners: ReturnType<typeof titleTiltCorners>,
): void {
  const { width, height } = layer;
  type Pt = { x: number; y: number };
  const lerpPt = (a: Pt, b: Pt, t: number): Pt => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  });
  // P(u,v): bilinear over the projected quad; u along the top edge.
  const P = (u: number, v: number): Pt =>
    lerpPt(
      lerpPt(corners.topLeft, corners.topRight, u),
      lerpPt(corners.bottomLeft, corners.bottomRight, u),
      v,
    );

  const slices = Math.min(180, Math.max(24, Math.round(height / 8)));
  const sliceSrcH = height / slices;
  for (let i = 0; i < slices; i++) {
    const v0 = i / slices;
    const v1 = (i + 1) / slices;

    // Affine approximation anchored on the strip's own left edge: origin at
    // its top, u-axis along that row, v-axis down to the row below.
    const topLeftRow = P(0, v0);
    const topRightRow = P(1, v0);
    const bottomLeftRow = P(0, v1);

    const ux = (topRightRow.x - topLeftRow.x) / width;
    const uy = (topRightRow.y - topLeftRow.y) / width;
    const vx = (bottomLeftRow.x - topLeftRow.x) / sliceSrcH;
    const vy = (bottomLeftRow.y - topLeftRow.y) / sliceSrcH;

    ctx.save();
    ctx.transform(ux, uy, vx, vy, topLeftRow.x, topLeftRow.y);
    ctx.drawImage(layer, 0, i * sliceSrcH, width, sliceSrcH, 0, 0, width, sliceSrcH);
    ctx.restore();
  }
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

  const tiltX = clip.titleTiltXDeg ?? 0;
  const tiltY = clip.titleTiltYDeg ?? 0;
  const tilted = tiltX !== 0 || tiltY !== 0;
  const useLayer = clip.titleFillMode !== undefined || tilted;

  // Solid styling pass, parameterized by target so it can draw straight to
  // the canvas or onto a layer that tilt/blur will then compose.
  const drawSolid = (g: Ctx2D): void => {
    g.save();
    g.globalAlpha = clip.opacity;
    g.font = font;

    if (clip.titleBackgroundColor) {
      let maxW = 0;
      for (const line of textLines) {
        const m = g.measureText(line);
        if (m.width > maxW) maxW = m.width;
      }
      const pad = Math.round(clip.titleBackgroundPadding ?? TITLE_BACKGROUND_PADDING_DEFAULT);
      const blockH = textLines.length * fontSize * 1.2 + (textLines.length - 1) * lineSpacing;
      g.fillStyle = clip.titleBackgroundColor;
      g.fillRect(
        centerX - maxW / 2 - pad,
        centerY - blockH / 2 - pad,
        maxW + pad * 2,
        blockH + pad * 2,
      );
    }

    g.fillStyle = clip.titleColor ?? '#ffffff';
    g.textAlign = align;
    g.textBaseline = 'middle';

    if (clip.titleStrokeWidth && clip.titleStrokeWidth > 0 && clip.titleStrokeColor) {
      g.strokeStyle = clip.titleStrokeColor;
      g.lineWidth = clip.titleStrokeWidth * 2; // canvas strokes centered
      g.lineJoin = 'round';
      for (const [i, line] of textLines.entries()) {
        const y = centerY + (i - (textLines.length - 1) / 2) * lineH;
        g.strokeText(line, centerX, y);
      }
    }

    for (const [i, line] of textLines.entries()) {
      const y = centerY + (i - (textLines.length - 1) / 2) * lineH;
      g.fillText(line, centerX, y);
    }
    g.restore();
  };

  const withBlur = (draw: () => void): void => {
    if (blur !== null) ctx.filter = `blur(${blur}px)`;
    draw();
    if (blur !== null) ctx.filter = 'none';
  };

  if (!useLayer) {
    withBlur(() => drawSolid(ctx));
    return;
  }

  // ── layer path: fill modes and/or tilt ────────────────────────────────────
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
  } else if (clip.titleFillMode === 'inverted') {
    // Inverted: opaque white silhouette; the export graph difference-blends
    // it, and preview mirrors that with the same composite operation below.
    lctx.fillStyle = '#ffffff';
    for (const [i, line] of textLines.entries()) {
      lctx.fillText(line, centerX, centerY + (i - (textLines.length - 1) / 2) * lineH);
    }
  } else {
    drawSolid(lctx);
  }

  if (tilted) {
    // Project through the same corner math upstream's TextTiltGeometry uses,
    // pivoting on the clip box center over a full-canvas raster.
    const corners = titleTiltCorners(
      { minX: 0, minY: 0, maxX: settings.width, maxY: settings.height },
      { x: centerX, y: centerY },
      tiltX,
      tiltY,
      settings,
    );
    drawLayerWithTilt(ctx, layer, corners);
    return;
  }

  withBlur(() => ctx.drawImage(layer, 0, 0));
}
