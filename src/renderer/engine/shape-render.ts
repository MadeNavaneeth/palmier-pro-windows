/**
 * Shape layer rendering, shared by the live preview, the GPU raster cache,
 * and the export baker.
 *
 * One function draws a shape clip's box content in box-local coordinates
 * (0,0,w,h), so preview and baked-export pixels cannot drift apart. The
 * caller owns the clip transform (position/rotation/scale from the static
 * fields or motion tracks) and opacity/fades — exactly like a decoded video
 * frame, which is also box-sized content placed by the compositor.
 *
 * Geometry convention: rect/ellipse fill the box; line/arrow run from the
 * box's top-left corner to its bottom-right corner. Lines and arrows are
 * stroke-only; fill is ignored for them.
 */

import type { Clip } from '../../shared/types/project';
import {
  sanitizeShapeFillColor,
  sanitizeShapeKind,
  sanitizeShapeStrokeColor,
  sanitizeShapeStrokeWidth,
  type ShapeKind,
} from '../../shared/editor/shape';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface ShapeBox {
  width: number;
  height: number;
}

/** Arrowhead half-angle (25°) and length bounds in px. */
const ARROW_HALF_ANGLE = (25 * Math.PI) / 180;
const ARROW_HEAD_MIN = 12;
const ARROW_HEAD_MAX = 48;

function resolvedStyle(clip: Clip): {
  kind: ShapeKind;
  strokeColor: string | null;
  strokeWidth: number;
  fillColor: string | null;
} {
  return {
    kind: sanitizeShapeKind(clip.shapeKind) ?? 'rect',
    strokeColor: sanitizeShapeStrokeColor(clip.shapeStrokeColor) ?? null,
    strokeWidth: sanitizeShapeStrokeWidth(clip.shapeStrokeWidth) ?? 0,
    fillColor: sanitizeShapeFillColor(clip.shapeFillColor) ?? null,
  };
}

/** Trace the shape's path in box-local coordinates. Null when degenerate. */
function tracePath(
  ctx: Ctx2D,
  kind: ShapeKind,
  w: number,
  h: number,
  strokeWidth: number,
): { arrowTip?: { x: number; y: number; dx: number; dy: number } } | null {
  const inset = Math.min(strokeWidth / 2, w / 2, h / 2);
  ctx.beginPath();
  if (kind === 'rect') {
    if (w - inset * 2 <= 0 || h - inset * 2 <= 0) return null;
    ctx.rect(inset, inset, w - inset * 2, h - inset * 2);
    return {};
  }
  if (kind === 'ellipse') {
    const rx = Math.max(0, (w - strokeWidth) / 2);
    const ry = Math.max(0, (h - strokeWidth) / 2);
    if (rx <= 0 || ry <= 0) return null;
    ctx.ellipse(w / 2, h / 2, rx, ry, 0, 0, Math.PI * 2);
    return {};
  }
  // Line and arrow: top-left corner to bottom-right corner, caps kept
  // inside the box by the stroke inset.
  const x0 = inset;
  const y0 = inset;
  const x1 = w - inset;
  const y1 = h - inset;
  if (x1 <= x0 || y1 <= y0) return null;
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  if (kind === 'line') return {};
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (!(len > 0)) return {};
  return { arrowTip: { x: x1, y: y1, dx: dx / len, dy: dy / len } };
}

function strokeArrowHead(
  ctx: Ctx2D,
  tip: { x: number; y: number; dx: number; dy: number },
  strokeWidth: number,
): void {
  const headLen = Math.max(
    ARROW_HEAD_MIN,
    Math.min(ARROW_HEAD_MAX, strokeWidth * 3 + 8),
  );
  const baseAngle = Math.atan2(tip.dy, tip.dx);
  for (const side of [1, -1]) {
    const angle = baseAngle + side * (Math.PI - ARROW_HALF_ANGLE);
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(tip.x + Math.cos(angle) * headLen, tip.y + Math.sin(angle) * headLen);
  }
}

export function drawShapeBox(ctx: Ctx2D, clip: Clip, box?: ShapeBox): void {
  if (clip.type !== 'shape') return;
  const w = box?.width ?? clip.width;
  const h = box?.height ?? clip.height;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return;
  const { kind, strokeColor, strokeWidth, fillColor } = resolvedStyle(clip);
  const stroked = strokeColor !== null && strokeWidth > 0;
  if (!stroked && fillColor === null) return;
  // Lines and arrows are stroke-only; without a stroke there is no path.
  if ((kind === 'line' || kind === 'arrow') && !stroked) return;

  const traced = tracePath(ctx, kind, w, h, stroked ? strokeWidth : 0);
  if (!traced) return;

  if (fillColor !== null && kind !== 'line' && kind !== 'arrow') {
    ctx.fillStyle = fillColor;
    ctx.fill();
  }
  if (stroked && strokeColor !== null) {
    if (traced.arrowTip) strokeArrowHead(ctx, traced.arrowTip, strokeWidth);
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = strokeWidth;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();
  }
}
