/**
 * Tests for grid layout presets and cell generation (upstream PR #410).
 * Verifies that the shared generator produces correct equal-sized cells
 * for 2×2, 3×3, and 4×4 grids, and that the controller's applyLayout
 * sets clip geometry correctly.
 */

import { describe, it, expect } from 'vitest';
import {
  generateGridCells,
  resolveLayoutPreset,
  listGridLayoutPresets,
} from './grid-layout';
import { EditorController } from './controller';

// ─── Pure generator tests ──────────────────────────────────────────────

describe('generateGridCells', () => {
  it('2x2 produces 4 equal cells on 1920x1080', () => {
    const cells = generateGridCells(2, 2, 1920, 1080);
    expect(cells).toHaveLength(4);
    // Each cell is 960×540
    for (const cell of cells) {
      expect(cell.width).toBe(960);
      expect(cell.height).toBe(540);
    }
  });

  it('3x3 produces 9 equal cells', () => {
    const cells = generateGridCells(3, 3, 1920, 1080);
    expect(cells).toHaveLength(9);
    for (const cell of cells) {
      expect(cell.width).toBe(640); // 1920/3
      expect(cell.height).toBe(360); // 1080/3
    }
  });

  it('4x4 produces 16 equal cells', () => {
    const cells = generateGridCells(4, 4, 1920, 1080);
    expect(cells).toHaveLength(16);
    for (const cell of cells) {
      expect(cell.width).toBe(480); // 1920/4
      expect(cell.height).toBe(270); // 1080/4
    }
  });

  it('cells are addressed row-major rNcN', () => {
    const cells = generateGridCells(2, 2, 1920, 1080);
    expect(cells.map((c) => c.slotId)).toEqual(['r1c1', 'r1c2', 'r2c1', 'r2c2']);
  });

  it('cells tile the canvas from top-left to bottom-right', () => {
    const cells = generateGridCells(2, 2, 1920, 1080);
    expect(cells[0]).toMatchObject({ row: 1, col: 1, x: 0, y: 0 });
    expect(cells[1]).toMatchObject({ row: 1, col: 2, x: 960, y: 0 });
    expect(cells[2]).toMatchObject({ row: 2, col: 1, x: 0, y: 540 });
    expect(cells[3]).toMatchObject({ row: 2, col: 2, x: 960, y: 540 });
  });

  it('handles non-divisible dimensions with floor rounding', () => {
    const cells = generateGridCells(3, 3, 1000, 750);
    // 1000/3 = 333 (floor), 750/3 = 250
    expect(cells[0]!.width).toBe(333);
    expect(cells[0]!.height).toBe(250);
    expect(cells[0]!.x).toBe(0);
    expect(cells[8]!.x).toBe(666); // 2 * 333
    expect(cells[8]!.y).toBe(500); // 2 * 250
  });
});

describe('resolveLayoutPreset', () => {
  it('resolves grid_2x2 to 4 cells', () => {
    expect(resolveLayoutPreset('grid_2x2', 1920, 1080)).toHaveLength(4);
  });

  it('resolves grid_3x3 to 9 cells', () => {
    expect(resolveLayoutPreset('grid_3x3', 1920, 1080)).toHaveLength(9);
  });

  it('resolves grid_4x4 to 16 cells', () => {
    expect(resolveLayoutPreset('grid_4x4', 1920, 1080)).toHaveLength(16);
  });
});

describe('listGridLayoutPresets', () => {
  it('returns 3 presets', () => {
    const presets = listGridLayoutPresets();
    expect(presets).toHaveLength(3);
    expect(presets.map((p) => p.id)).toEqual(['grid_2x2', 'grid_3x3', 'grid_4x4']);
  });

  it('reports correct cell counts', () => {
    const presets = listGridLayoutPresets();
    expect(presets[0]!.cellCount).toBe(4);
    expect(presets[1]!.cellCount).toBe(9);
    expect(presets[2]!.cellCount).toBe(16);
  });
});

// ─── Controller integration ────────────────────────────────────────────

describe('EditorController.applyLayout', () => {
  function setup() {
    const ctrl = new EditorController();
    // Add 4 video clips to the default V1 track.
    ctrl.addMedia({ id: 'v1', path: '/a.mp4', filename: 'a.mp4', type: 'video', duration: 300, fileSize: 1, addedAt: new Date().toISOString() });
    ctrl.addMedia({ id: 'v2', path: '/b.mp4', filename: 'b.mp4', type: 'video', duration: 300, fileSize: 1, addedAt: new Date().toISOString() });
    ctrl.addMedia({ id: 'v3', path: '/c.mp4', filename: 'c.mp4', type: 'video', duration: 300, fileSize: 1, addedAt: new Date().toISOString() });
    ctrl.addMedia({ id: 'v4', path: '/d.mp4', filename: 'd.mp4', type: 'video', duration: 300, fileSize: 1, addedAt: new Date().toISOString() });
    const c1 = ctrl.addClip({ assetId: 'v1', trackId: 'v1', startFrame: 0, durationFrames: 100 })!;
    const c2 = ctrl.addClip({ assetId: 'v2', trackId: 'v1', startFrame: 0, durationFrames: 100 })!;
    const c3 = ctrl.addClip({ assetId: 'v3', trackId: 'v1', startFrame: 0, durationFrames: 100 })!;
    const c4 = ctrl.addClip({ assetId: 'v4', trackId: 'v1', startFrame: 0, durationFrames: 100 })!;
    return { ctrl, clips: [c1, c2, c3, c4] };
  }

  it('applies grid_2x2 geometry to 4 clips', () => {
    const { ctrl, clips } = setup();
    const changed = ctrl.applyLayout(clips, 'grid_2x2');
    expect(changed).toBe(4);

    const allClips = ctrl.getClips();
    const c1 = allClips.find((c) => c.id === clips[0])!;
    const c2 = allClips.find((c) => c.id === clips[1])!;
    const c3 = allClips.find((c) => c.id === clips[2])!;
    const c4 = allClips.find((c) => c.id === clips[3])!;

    expect(c1).toMatchObject({ x: 0, y: 0, width: 960, height: 540, scaleX: 1, scaleY: 1 });
    expect(c2).toMatchObject({ x: 960, y: 0, width: 960, height: 540 });
    expect(c3).toMatchObject({ x: 0, y: 540, width: 960, height: 540 });
    expect(c4).toMatchObject({ x: 960, y: 540, width: 960, height: 540 });
  });

  it('skips audio clips in layout', () => {
    const ctrl = new EditorController();
    ctrl.addMedia({ id: 'a1', path: '/a.mp3', filename: 'a.mp3', type: 'audio', duration: 300, fileSize: 1, addedAt: new Date().toISOString() });
    ctrl.addMedia({ id: 'v1', path: '/v.mp4', filename: 'v.mp4', type: 'video', duration: 300, fileSize: 1, addedAt: new Date().toISOString() });
    const audioClip = ctrl.addClip({ assetId: 'a1', trackId: 'a1', startFrame: 0, durationFrames: 100 })!;
    const videoClip = ctrl.addClip({ assetId: 'v1', trackId: 'v1', startFrame: 0, durationFrames: 100 })!;

    const changed = ctrl.applyLayout([audioClip, videoClip], 'grid_2x2');
    expect(changed).toBe(1); // only the video clip
  });

  it('returns 0 for empty clip list', () => {
    const { ctrl } = setup();
    expect(ctrl.applyLayout([], 'grid_2x2')).toBe(0);
  });

  it('returns 0 for nonexistent clip ids', () => {
    const { ctrl } = setup();
    expect(ctrl.applyLayout(['fake-id'], 'grid_2x2')).toBe(0);
  });

  it('only fills available cells, extras unchanged', () => {
    const { ctrl, clips } = setup();
    // Apply 3x3 layout with only 4 clips — 4 get positioned, nothing crashes.
    const changed = ctrl.applyLayout(clips, 'grid_3x3');
    expect(changed).toBe(4);
    // Verify all 4 clips got 3x3 cell geometry (640×360).
    const allClips = ctrl.getClips();
    for (const id of clips) {
      const c = allClips.find((cl) => cl.id === id)!;
      expect(c.width).toBe(640);
      expect(c.height).toBe(360);
    }
  });

  it('grid_4x4 on 4 clips produces 4 cells of 480×270', () => {
    const { ctrl, clips } = setup();
    const changed = ctrl.applyLayout(clips, 'grid_4x4');
    expect(changed).toBe(4);

    const allClips = ctrl.getClips();
    const c1 = allClips.find((c) => c.id === clips[0])!;
    expect(c1).toMatchObject({ x: 0, y: 0, width: 480, height: 270 });
  });
});
