/**
 * Video layouts — the multi-clip arrangement catalogue.
 *
 * This is the Windows analogue of upstream's `VideoLayout` enum: the full set
 * of arrangements `apply_layout` accepts, each described as a list of named
 * slots holding a normalized 0..1 rect of the canvas. Slot ids match upstream
 * (`main`, `left`/`right`, `top`/`bottom`, `inset`, `sidebar`, `center`,
 * `middle`, and row-major `rNcN` for grids) so an agent's layout vocabulary
 * transfers between platforms.
 *
 * The three grid presets keep their own pixel-space generator
 * (`generateGridCells`) so the tiling math cannot drift between them — that is
 * upstream's `grid(rows:columns:)`, and every grid preset feeds its row and
 * column counts through it.
 */

/** Normalized rect within the canvas: 0..1 on both axes. */
export interface LayoutRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutSlot {
  /** Slot id, e.g. "main", "left", "r1c1". */
  id: string;
  rect: LayoutRect;
  /** Stacking order inside the layout; higher draws on top. */
  z: number;
}

/** Every arrangement `apply_layout` accepts, in upstream's declaration order. */
export const VIDEO_LAYOUT_PRESETS = [
  'full',
  'side_by_side',
  'top_bottom',
  'pip_bottom_right',
  'pip_bottom_left',
  'pip_top_right',
  'pip_top_left',
  'grid_2x2',
  'grid_3x3',
  'grid_4x4',
  'main_sidebar',
  'three_up',
  'three_stack',
] as const;

export type VideoLayoutPreset = (typeof VIDEO_LAYOUT_PRESETS)[number];

/** The mosaic presets the timeline's Layout menu offers. */
export type GridLayoutPreset = Extract<
  VideoLayoutPreset,
  'grid_2x2' | 'grid_3x3' | 'grid_4x4'
>;

/** A slot resolved into canvas pixels. */
export interface ResolvedLayoutSlot {
  slotId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  /** Present on grid presets, whose cells are addressed row-major. */
  row?: number;
  col?: number;
}

export interface GridLayoutCell {
  /** 1-based row index. */
  row: number;
  /** 1-based column index. */
  col: number;
  /** Slot id, e.g. "r1c1". */
  slotId: string;
  /** Left edge in canvas pixels. */
  x: number;
  /** Top edge in canvas pixels. */
  y: number;
  /** Cell width in canvas pixels. */
  width: number;
  /** Cell height in canvas pixels. */
  height: number;
}

/** Grid dimensions for each grid preset. */
const GRID_DIMENSIONS: Record<GridLayoutPreset, { rows: number; cols: number }> = {
  grid_2x2: { rows: 2, cols: 2 },
  grid_3x3: { rows: 3, cols: 3 },
  grid_4x4: { rows: 4, cols: 4 },
};

/** Upstream's PiP inset is 28% of the frame, held 3.5% off the edges. */
const PIP_INSET = 0.28;
const PIP_MARGIN = 0.035;

function pip(insetX: number, insetY: number): LayoutSlot[] {
  return [
    { id: 'main', rect: { x: 0, y: 0, w: 1, h: 1 }, z: 0 },
    { id: 'inset', rect: { x: insetX, y: insetY, w: PIP_INSET, h: PIP_INSET }, z: 1 },
  ];
}

function gridSlots(rows: number, cols: number): LayoutSlot[] {
  const w = 1 / cols;
  const h = 1 / rows;
  const slots: LayoutSlot[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      slots.push({
        id: `r${row + 1}c${col + 1}`,
        rect: { x: col * w, y: row * h, w, h },
        z: 0,
      });
    }
  }
  return slots;
}

const THIRD = 1 / 3;

/** Slot geometry for every preset, as normalized canvas rects. */
const LAYOUT_SLOTS: Record<VideoLayoutPreset, LayoutSlot[]> = {
  full: [{ id: 'main', rect: { x: 0, y: 0, w: 1, h: 1 }, z: 0 }],

  side_by_side: [
    { id: 'left', rect: { x: 0, y: 0, w: 0.5, h: 1 }, z: 0 },
    { id: 'right', rect: { x: 0.5, y: 0, w: 0.5, h: 1 }, z: 0 },
  ],

  top_bottom: [
    { id: 'top', rect: { x: 0, y: 0, w: 1, h: 0.5 }, z: 0 },
    { id: 'bottom', rect: { x: 0, y: 0.5, w: 1, h: 0.5 }, z: 0 },
  ],

  pip_bottom_right: pip(1 - PIP_MARGIN - PIP_INSET, 1 - PIP_MARGIN - PIP_INSET),
  pip_bottom_left: pip(PIP_MARGIN, 1 - PIP_MARGIN - PIP_INSET),
  pip_top_right: pip(1 - PIP_MARGIN - PIP_INSET, PIP_MARGIN),
  pip_top_left: pip(PIP_MARGIN, PIP_MARGIN),

  grid_2x2: gridSlots(2, 2),
  grid_3x3: gridSlots(3, 3),
  grid_4x4: gridSlots(4, 4),

  main_sidebar: [
    { id: 'main', rect: { x: 0, y: 0, w: 0.7, h: 1 }, z: 0 },
    { id: 'sidebar', rect: { x: 0.7, y: 0, w: 0.3, h: 1 }, z: 0 },
  ],

  three_up: [
    { id: 'left', rect: { x: 0, y: 0, w: THIRD, h: 1 }, z: 0 },
    { id: 'center', rect: { x: THIRD, y: 0, w: THIRD, h: 1 }, z: 0 },
    { id: 'right', rect: { x: THIRD * 2, y: 0, w: THIRD, h: 1 }, z: 0 },
  ],

  three_stack: [
    { id: 'top', rect: { x: 0, y: 0, w: 1, h: THIRD }, z: 0 },
    { id: 'middle', rect: { x: 0, y: THIRD, w: 1, h: THIRD }, z: 0 },
    { id: 'bottom', rect: { x: 0, y: THIRD * 2, w: 1, h: THIRD }, z: 0 },
  ],
};

/** True when `value` names a preset in the catalogue. */
export function isVideoLayoutPreset(value: string): value is VideoLayoutPreset {
  return (VIDEO_LAYOUT_PRESETS as readonly string[]).includes(value);
}

/** Normalized slots for a preset, in draw order (lower `z` first). */
export function layoutSlots(preset: VideoLayoutPreset): LayoutSlot[] {
  return LAYOUT_SLOTS[preset].slice().sort((a, b) => a.z - b.z);
}

/** Slot ids a preset expects, in draw order. */
export function layoutSlotIds(preset: VideoLayoutPreset): string[] {
  return layoutSlots(preset).map((slot) => slot.id);
}

/**
 * Generate equal-sized grid cells for the given canvas dimensions.
 *
 * This is the shared generator upstream calls `grid(rows:columns:)`.
 * Every grid preset feeds its row/column counts here.
 */
export function generateGridCells(
  rows: number,
  cols: number,
  canvasWidth: number,
  canvasHeight: number,
): GridLayoutCell[] {
  const cellWidth = Math.floor(canvasWidth / cols);
  const cellHeight = Math.floor(canvasHeight / rows);
  const cells: GridLayoutCell[] = [];

  for (let r = 1; r <= rows; r++) {
    for (let c = 1; c <= cols; c++) {
      cells.push({
        row: r,
        col: c,
        slotId: `r${r}c${c}`,
        x: (c - 1) * cellWidth,
        y: (r - 1) * cellHeight,
        width: cellWidth,
        height: cellHeight,
      });
    }
  }

  return cells;
}

/**
 * Resolve a preset's slots into canvas pixels.
 *
 * Grid presets route through `generateGridCells` so they keep that
 * generator's floor-rounded tiling; the rest convert their normalized rects.
 */
export function resolveLayoutPreset(
  preset: VideoLayoutPreset,
  canvasWidth: number,
  canvasHeight: number,
): ResolvedLayoutSlot[] {
  if (preset in GRID_DIMENSIONS) {
    const dims = GRID_DIMENSIONS[preset as GridLayoutPreset];
    return generateGridCells(dims.rows, dims.cols, canvasWidth, canvasHeight)
      .map((cell) => ({ ...cell, z: 0 }));
  }

  return layoutSlots(preset).map((slot) => ({
    slotId: slot.id,
    x: Math.round(slot.rect.x * canvasWidth),
    y: Math.round(slot.rect.y * canvasHeight),
    width: Math.round(slot.rect.w * canvasWidth),
    height: Math.round(slot.rect.h * canvasHeight),
    z: slot.z,
  }));
}

/**
 * List the grid presets the timeline Layout menu offers, with metadata.
 */
export function listGridLayoutPresets(): Array<{
  id: GridLayoutPreset;
  label: string;
  rows: number;
  cols: number;
  cellCount: number;
}> {
  return (Object.keys(GRID_DIMENSIONS) as GridLayoutPreset[]).map((id) => {
    const dims = GRID_DIMENSIONS[id];
    return {
      id,
      label: `${dims.rows}×${dims.cols}`,
      rows: dims.rows,
      cols: dims.cols,
      cellCount: dims.rows * dims.cols,
    };
  });
}
