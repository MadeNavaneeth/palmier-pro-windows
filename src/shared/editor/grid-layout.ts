/**
 * Grid Layout — multi-clip mosaic presets and a shared row-major generator.
 *
 * Upstream PR #410 adds 2×2, 3×3, and 4×4 grid layouts to apply_layout.
 * All three use a single `grid(rows, cols)` generator so the tiling math
 * cannot drift between presets. Cells are addressed row-major as rNcN
 * (r1c1, r1c2, …, rNcN) — no named slot ids.
 *
 * The caller provides canvas dimensions (project width × height) and the
 * clip ids to lay out. Each clip is assigned an equal-sized cell within the
 * canvas, positioned at (x, y) with (cellWidth, cellHeight).
 */

export type GridLayoutPreset = 'grid_2x2' | 'grid_3x3' | 'grid_4x4';

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

/** Grid dimensions for each preset. */
const GRID_DIMENSIONS: Record<GridLayoutPreset, { rows: number; cols: number }> = {
  grid_2x2: { rows: 2, cols: 2 },
  grid_3x3: { rows: 3, cols: 3 },
  grid_4x4: { rows: 4, cols: 4 },
};

/**
 * Generate equal-sized grid cells for the given canvas dimensions.
 *
 * This is the shared generator upstream calls `grid(rows:columns:)`.
 * Every preset feeds its row/column counts here.
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
 * Resolve a preset name to its grid cells.
 */
export function resolveLayoutPreset(
  preset: GridLayoutPreset,
  canvasWidth: number,
  canvasHeight: number,
): GridLayoutCell[] {
  const dims = GRID_DIMENSIONS[preset];
  return generateGridCells(dims.rows, dims.cols, canvasWidth, canvasHeight);
}

/**
 * List all available grid presets with their metadata.
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
