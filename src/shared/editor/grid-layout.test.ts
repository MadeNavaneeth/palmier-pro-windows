/**
 * Tests for grid layout presets and cell generation (upstream PR #410).
 * Verifies that the shared generator produces correct equal-sized cells
 * for 2×2, 3×3, and 4×4 grids, and that the controller's applyLayout
 * sets clip geometry correctly.
 */

import { describe, it, expect } from 'vitest';
import {
  VIDEO_LAYOUT_PRESETS,
  generateGridCells,
  isVideoLayoutPreset,
  layoutSlotIds,
  layoutSlots,
  listGridLayoutPresets,
  resolveLayoutPreset,
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

// ─── Full catalogue (upstream VideoLayout) ─────────────────────────────

describe('VIDEO_LAYOUT_PRESETS', () => {
  it('carries every preset upstream ships, under the same raw values', () => {
    expect(VIDEO_LAYOUT_PRESETS).toEqual([
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
    ]);
  });

  it('names the slots the way the agent vocabulary expects', () => {
    expect(layoutSlotIds('full')).toEqual(['main']);
    expect(layoutSlotIds('side_by_side')).toEqual(['left', 'right']);
    expect(layoutSlotIds('top_bottom')).toEqual(['top', 'bottom']);
    expect(layoutSlotIds('main_sidebar')).toEqual(['main', 'sidebar']);
    expect(layoutSlotIds('three_up')).toEqual(['left', 'center', 'right']);
    expect(layoutSlotIds('three_stack')).toEqual(['top', 'middle', 'bottom']);
    for (const pip of ['pip_bottom_right', 'pip_bottom_left', 'pip_top_right', 'pip_top_left'] as const) {
      expect(layoutSlotIds(pip)).toEqual(['main', 'inset']);
    }
    expect(layoutSlotIds('grid_3x3')).toEqual([
      'r1c1', 'r1c2', 'r1c3', 'r2c1', 'r2c2', 'r2c3', 'r3c1', 'r3c2', 'r3c3',
    ]);
  });

  it('keeps every slot inside the canvas', () => {
    for (const preset of VIDEO_LAYOUT_PRESETS) {
      for (const slot of layoutSlots(preset)) {
        expect(slot.rect.x, `${preset}/${slot.id} x`).toBeGreaterThanOrEqual(0);
        expect(slot.rect.y, `${preset}/${slot.id} y`).toBeGreaterThanOrEqual(0);
        expect(slot.rect.x + slot.rect.w, `${preset}/${slot.id} right edge`)
          .toBeLessThanOrEqual(1 + 1e-9);
        expect(slot.rect.y + slot.rect.h, `${preset}/${slot.id} bottom edge`)
          .toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });

  it('has no duplicate slot id within a preset', () => {
    for (const preset of VIDEO_LAYOUT_PRESETS) {
      const ids = layoutSlotIds(preset);
      expect(new Set(ids).size, preset).toBe(ids.length);
    }
  });

  it('splits the frame evenly for the non-grid splits', () => {
    expect(layoutSlots('side_by_side').map((s) => s.rect.w)).toEqual([0.5, 0.5]);
    expect(layoutSlots('top_bottom').map((s) => s.rect.h)).toEqual([0.5, 0.5]);
    const thirds = layoutSlots('three_up').map((s) => s.rect.w);
    for (const w of thirds) expect(w).toBeCloseTo(1 / 3, 12);
    expect(layoutSlots('three_up')[2]!.rect.x).toBeCloseTo(2 / 3, 12);
  });

  it('gives the sidebar 30% of the width', () => {
    const [main, sidebar] = layoutSlots('main_sidebar');
    expect(main!.rect.w).toBeCloseTo(0.7, 12);
    expect(sidebar!.rect).toMatchObject({ x: 0.7, w: 0.3 });
  });

  it('sizes the PiP inset at 28% held 3.5% off its corner, above the main slot', () => {
    for (const [preset, corner] of [
      ['pip_top_left', { x: 0.035, y: 0.035 }],
      ['pip_top_right', { x: 0.685, y: 0.035 }],
      ['pip_bottom_left', { x: 0.035, y: 0.685 }],
      ['pip_bottom_right', { x: 0.685, y: 0.685 }],
    ] as const) {
      const [main, inset] = layoutSlots(preset);
      expect(main!.rect).toEqual({ x: 0, y: 0, w: 1, h: 1 });
      expect(main!.z).toBe(0);
      expect(inset!.rect.x, preset).toBeCloseTo(corner.x, 12);
      expect(inset!.rect.y, preset).toBeCloseTo(corner.y, 12);
      expect(inset!.rect.w).toBeCloseTo(0.28, 12);
      expect(inset!.rect.h).toBeCloseTo(0.28, 12);
      // Draw order is what keeps the camera over the screen recording.
      expect(inset!.z).toBeGreaterThan(main!.z);
    }
  });

  it('recognises preset names and rejects anything else', () => {
    expect(isVideoLayoutPreset('three_up')).toBe(true);
    expect(isVideoLayoutPreset('grid_2x2')).toBe(true);
    expect(isVideoLayoutPreset('mosaic')).toBe(false);
    expect(isVideoLayoutPreset('')).toBe(false);
  });
});

describe('resolveLayoutPreset for non-grid presets', () => {
  const W = 1920;
  const H = 1080;

  it('fills the canvas for full', () => {
    expect(resolveLayoutPreset('full', W, H)).toEqual([
      { slotId: 'main', x: 0, y: 0, width: W, height: H, z: 0 },
    ]);
  });

  it('halves the canvas for the two-way splits', () => {
    expect(resolveLayoutPreset('side_by_side', W, H).map((s) => [s.slotId, s.x, s.y, s.width, s.height]))
      .toEqual([['left', 0, 0, 960, 1080], ['right', 960, 0, 960, 1080]]);
    expect(resolveLayoutPreset('top_bottom', W, H).map((s) => [s.slotId, s.x, s.y, s.width, s.height]))
      .toEqual([['top', 0, 0, 1920, 540], ['bottom', 0, 540, 1920, 540]]);
  });

  it('places the PiP inset in its corner at 28% of the frame', () => {
    expect(resolveLayoutPreset('pip_top_left', W, H).map((s) => [s.slotId, s.x, s.y, s.width, s.height, s.z]))
      .toEqual([['main', 0, 0, 1920, 1080, 0], ['inset', 67, 38, 538, 302, 1]]);
    expect(resolveLayoutPreset('pip_bottom_right', W, H).map((s) => [s.slotId, s.x, s.y, s.width, s.height, s.z]))
      .toEqual([['main', 0, 0, 1920, 1080, 0], ['inset', 1315, 740, 538, 302, 1]]);
  });

  it('splits 70/30 for main_sidebar', () => {
    expect(resolveLayoutPreset('main_sidebar', W, H).map((s) => [s.slotId, s.x, s.width]))
      .toEqual([['main', 0, 1344], ['sidebar', 1344, 576]]);
  });

  it('returns grid presets through the shared generator, unchanged', () => {
    const cells = resolveLayoutPreset('grid_3x3', W, H);
    expect(cells).toHaveLength(9);
    expect(cells[0]).toMatchObject({ slotId: 'r1c1', row: 1, col: 1, x: 0, y: 0, width: 640, height: 360, z: 0 });
    expect(cells[8]).toMatchObject({ slotId: 'r3c3', row: 3, col: 3, x: 1280, y: 720, width: 640, height: 360 });
  });

  it('resolves a vertical canvas without stretching the insets', () => {
    const [main, inset] = resolveLayoutPreset('pip_top_right', 1080, 1920);
    expect(main).toMatchObject({ x: 0, y: 0, width: 1080, height: 1920 });
    expect(inset!.x + inset!.width).toBeLessThanOrEqual(1080);
    expect(inset!.y + inset!.height).toBeLessThanOrEqual(1920);
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

  it('splits two clips across the frame for side_by_side', () => {
    const { ctrl, clips } = setup();
    expect(ctrl.applyLayout(clips.slice(0, 2), 'side_by_side')).toBe(2);

    const allClips = ctrl.getClips();
    const left = allClips.find((c) => c.id === clips[0])!;
    const right = allClips.find((c) => c.id === clips[1])!;
    expect(left).toMatchObject({ x: 0, y: 0, width: 960, height: 1080 });
    expect(right).toMatchObject({ x: 960, y: 0, width: 960, height: 1080 });
  });

  it('puts the second clip on the PiP inset, above the main slot', () => {
    const { ctrl, clips } = setup();
    expect(ctrl.applyLayout(clips.slice(0, 2), 'pip_bottom_right')).toBe(2);

    const allClips = ctrl.getClips();
    const main = allClips.find((c) => c.id === clips[0])!;
    const inset = allClips.find((c) => c.id === clips[1])!;
    expect(main).toMatchObject({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(inset).toMatchObject({ x: 1315, y: 740, width: 538, height: 302 });
  });

  it('lays three clips out as thirds for three_up', () => {
    const { ctrl, clips } = setup();
    expect(ctrl.applyLayout(clips.slice(0, 3), 'three_up')).toBe(3);

    const allClips = ctrl.getClips();
    expect(allClips.find((c) => c.id === clips[0])!).toMatchObject({ x: 0, width: 640, height: 1080 });
    expect(allClips.find((c) => c.id === clips[1])!).toMatchObject({ x: 640, width: 640 });
    expect(allClips.find((c) => c.id === clips[2])!).toMatchObject({ x: 1280, width: 640 });
  });

  it('expands a single clip to the full frame', () => {
    const { ctrl, clips } = setup();
    ctrl.applyLayout(clips.slice(0, 2), 'side_by_side');
    expect(ctrl.applyLayout(clips.slice(0, 1), 'full')).toBe(1);

    const restored = ctrl.getClips().find((c) => c.id === clips[0])!;
    expect(restored).toMatchObject({ x: 0, y: 0, width: 1920, height: 1080 });
    // The clip that was not part of the second call keeps its slot.
    expect(ctrl.getClips().find((c) => c.id === clips[1])!)
      .toMatchObject({ x: 960, width: 960 });
  });

  it('undoes a non-grid layout in one step', () => {
    const { ctrl, clips } = setup();
    // Copy the geometry out: getClips() hands back the live clip, so holding
    // the reference would compare the object against itself after undo.
    const { x: x0, y: y0, width: w0, height: h0 } = ctrl.getClips().find((c) => c.id === clips[0])!;
    ctrl.applyLayout(clips.slice(0, 2), 'side_by_side');
    expect(ctrl.getClips().find((c) => c.id === clips[0])!.width).toBe(960);

    ctrl.undo();
    const after = ctrl.getClips().find((c) => c.id === clips[0])!;
    expect({ x: after.x, y: after.y, width: after.width, height: after.height })
      .toEqual({ x: x0, y: y0, width: w0, height: h0 });
  });
});
