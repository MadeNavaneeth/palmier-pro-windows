/**
 * Viewer guide geometry (upstream issue #167).
 *
 * Composition overlays for the preview: a centre cross, rule-of-thirds lines, an
 * optional grid, and broadcast action/title safe areas.
 *
 * Everything here is normalized to the unit square, so one set of numbers works
 * for any project resolution and for the scaled-to-fit preview without a second
 * conversion step. The one exception is the centre cross, whose arms have to be
 * corrected for aspect ratio or they stop being square on a non-square canvas.
 *
 * These guides are strictly a viewing aid. They are drawn by the renderer over
 * the composited frame and are deliberately not part of the compositor or
 * exporter input, so enabling them can never bake marks into an export.
 */

/** Canvas shape the geometry is being computed for. */
export interface GuideCanvas {
  width: number;
  height: number;
}

/** A line segment in normalized [0,1] coordinates, origin top-left. */
export interface GuideLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** A rectangle in normalized [0,1] coordinates, origin top-left. */
export interface GuideRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GuideGeometry {
  lines: GuideLine[];
  rects: GuideRect[];
}

export type GuideKind = 'center' | 'thirds' | 'grid' | 'actionSafe' | 'titleSafe';

export const GUIDE_KINDS: readonly GuideKind[] = [
  'center',
  'thirds',
  'grid',
  'actionSafe',
  'titleSafe',
] as const;

export const GUIDE_LABELS: Record<GuideKind, string> = {
  center: 'Center cross',
  thirds: 'Rule of thirds',
  grid: 'Grid',
  actionSafe: 'Action safe (90%)',
  titleSafe: 'Title safe (80%)',
};

/**
 * SMPTE/EBU broadcast safe-area insets, as a fraction of each edge.
 *
 * Action safe keeps the frame's action inside 90% of the width and height,
 * title safe keeps text inside 80%. These are the conventional values delivery
 * specs are written against, which is the point of showing them at all.
 */
export const ACTION_SAFE_INSET = 0.05;
export const TITLE_SAFE_INSET = 0.1;

/** Grid divisions per axis. */
export const GRID_DIVISIONS = 4;

/** Centre cross arm length, as a fraction of the shorter canvas edge. */
export const CENTER_ARM_FRACTION = 0.04;

function isUsableCanvas(canvas: GuideCanvas): boolean {
  return (
    Number.isFinite(canvas.width)
    && Number.isFinite(canvas.height)
    && canvas.width > 0
    && canvas.height > 0
  );
}

/**
 * Rule-of-thirds lines: two vertical, two horizontal.
 *
 * Independent of aspect ratio — thirds of the frame are thirds in either
 * orientation.
 */
export function thirdsLines(): GuideLine[] {
  return [
    { x1: 1 / 3, y1: 0, x2: 1 / 3, y2: 1 },
    { x1: 2 / 3, y1: 0, x2: 2 / 3, y2: 1 },
    { x1: 0, y1: 1 / 3, x2: 1, y2: 1 / 3 },
    { x1: 0, y1: 2 / 3, x2: 1, y2: 2 / 3 },
  ];
}

/**
 * Interior grid lines for `divisions` cells per axis.
 *
 * Frame edges are omitted: the canvas boundary is already visible, and drawing
 * over it produces a half-width line clipped by the canvas edge.
 */
export function gridLines(divisions: number = GRID_DIVISIONS): GuideLine[] {
  const count = Math.floor(divisions);
  if (!Number.isFinite(count) || count < 2) return [];

  const lines: GuideLine[] = [];
  for (let index = 1; index < count; index += 1) {
    const offset = index / count;
    lines.push({ x1: offset, y1: 0, x2: offset, y2: 1 });
    lines.push({ x1: 0, y1: offset, x2: 1, y2: offset });
  }
  return lines;
}

/**
 * Centre cross with arms of equal on-screen length.
 *
 * The arm length is a fraction of the *shorter* edge, then converted separately
 * per axis. Using the same normalized length on both axes would stretch the
 * cross with the aspect ratio, so a 16:9 frame would show a wide, squat cross
 * and a vertical 9:16 frame a tall thin one.
 */
export function centerCrossLines(
  canvas: GuideCanvas,
  armFraction: number = CENTER_ARM_FRACTION,
): GuideLine[] {
  if (!isUsableCanvas(canvas)) return [];
  const fraction = Number.isFinite(armFraction) ? Math.min(Math.max(armFraction, 0), 0.5) : 0;
  if (fraction <= 0) return [];

  const armPixels = Math.min(canvas.width, canvas.height) * fraction;
  const armX = armPixels / canvas.width;
  const armY = armPixels / canvas.height;

  return [
    { x1: 0.5 - armX, y1: 0.5, x2: 0.5 + armX, y2: 0.5 },
    { x1: 0.5, y1: 0.5 - armY, x2: 0.5, y2: 0.5 + armY },
  ];
}

/**
 * Safe-area rectangle for a per-edge inset.
 *
 * The inset is a fraction of each edge, so 0.05 leaves a rectangle covering the
 * middle 90% of both width and height.
 */
export function safeAreaRect(inset: number): GuideRect | null {
  if (!Number.isFinite(inset) || inset < 0 || inset >= 0.5) return null;
  return { x: inset, y: inset, width: 1 - inset * 2, height: 1 - inset * 2 };
}

/**
 * Geometry for the enabled guides, in draw order.
 *
 * Unknown kinds are ignored rather than throwing: the set can come from
 * persisted preferences written by an older or newer build.
 */
export function guideGeometry(
  enabled: Iterable<GuideKind>,
  canvas: GuideCanvas,
): GuideGeometry {
  const kinds = new Set(enabled);
  const lines: GuideLine[] = [];
  const rects: GuideRect[] = [];

  if (kinds.has('grid')) lines.push(...gridLines());
  if (kinds.has('thirds')) lines.push(...thirdsLines());
  if (kinds.has('center')) lines.push(...centerCrossLines(canvas));

  if (kinds.has('actionSafe')) {
    const rect = safeAreaRect(ACTION_SAFE_INSET);
    if (rect) rects.push(rect);
  }
  if (kinds.has('titleSafe')) {
    const rect = safeAreaRect(TITLE_SAFE_INSET);
    if (rect) rects.push(rect);
  }

  return { lines, rects };
}

/** True when at least one guide would draw something. */
export function hasVisibleGuides(enabled: Iterable<GuideKind>, canvas: GuideCanvas): boolean {
  const geometry = guideGeometry(enabled, canvas);
  return geometry.lines.length > 0 || geometry.rects.length > 0;
}

/** Narrow an untrusted string to a guide kind, for persisted preferences. */
export function asGuideKind(value: unknown): GuideKind | null {
  return typeof value === 'string' && (GUIDE_KINDS as readonly string[]).includes(value)
    ? (value as GuideKind)
    : null;
}
