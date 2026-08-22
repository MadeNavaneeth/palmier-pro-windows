/**
 * Regression coverage for the manage_tracks controller operation (upstream
 * PR #520): selector rules, type-zone reordering, key-presence rename
 * semantics, guarded removal, and the single-undo-step guarantee.
 */

import { describe, it, expect } from 'vitest';
import { EditorController } from './controller';

describe('EditorController.manageTracks (#520)', () => {
  it('renames by trackId and clears to the generated label with an empty string', () => {
    const ctrl = new EditorController();
    const receipt = ctrl.manageTracks({ set: [{ trackId: 'v1', name: 'Interview' }] });
    expect(receipt?.renamed).toEqual([{ trackId: 'v1', name: 'Interview', changed: true }]);
    expect(ctrl.getTracks().find((t) => t.id === 'v1')?.name).toBe('Interview');

    ctrl.manageTracks({ set: [{ trackId: 'v1', name: '' }] });
    expect(ctrl.getTracks().find((t) => t.id === 'v1')?.name).toBe('Video 1');
  });

  it('folds muted/hidden onto the single visible toggle', () => {
    const ctrl = new EditorController();
    ctrl.manageTracks({ set: [{ trackId: 'a1', muted: true }] });
    expect(ctrl.getTracks().find((t) => t.id === 'a1')?.visible).toBe(false);

    ctrl.manageTracks({ set: [{ trackId: 'v1', hidden: true }] });
    expect(ctrl.getTracks().find((t) => t.id === 'v1')?.visible).toBe(false);
  });

  it('reorders within a type zone and refuses crossing it', () => {
    const ctrl = new EditorController();
    // Array: [v1, a1, v2, a2] — types alternate, so zone edges are visible.
    const v2 = ctrl.addTrack('video', 'Video 2');
    const a2 = ctrl.addTrack('audio', 'Audio 2');

    // Video track into an audio slot: refused.
    expect(() => ctrl.manageTracks({ reorder: [{ trackId: v2, to: 1 }] }))
      .toThrow(/outside the track's type zone/i);

    // Video into the other video's slot: fine.
    const receipt = ctrl.manageTracks({ reorder: [{ trackId: v2, to: 0 }] });
    expect(receipt?.reordered).toEqual([{ trackId: v2, from: 2, to: 0, changed: true }]);
    expect(ctrl.getTracks().map((t) => t.id)).toEqual([v2, 'v1', 'a1', a2]);
  });

  it('applies reorders, sets, and removes as one undo step', () => {
    const ctrl = new EditorController();
    const v2 = ctrl.addTrack('video', 'Video 2');
    const canUndoBefore = ctrl.canUndo();

    const receipt = ctrl.manageTracks({
      set: [{ trackId: 'v1', name: 'Main' }],
      remove: [v2],
    });
    expect(receipt?.removedTracks).toEqual([
      { trackId: v2, label: 'Video 2', type: 'video' },
    ]);
    expect(ctrl.getTracks()).toHaveLength(2);

    ctrl.undo();
    // One undo restores both the rename and the removal.
    expect(ctrl.getTracks()).toHaveLength(3);
    expect(ctrl.getTracks().find((t) => t.id === 'v1')?.name).toBe('Video 1');
    expect(ctrl.canUndo()).toBe(canUndoBefore);
  });

  it('enforces exactly one selector per entry', () => {
    const ctrl = new EditorController();
    expect(() => ctrl.manageTracks({ set: [{ trackId: 'v1', index: 0, name: 'X' }] }))
      .toThrow(/pass one current trackId or index/i);
    expect(() => ctrl.manageTracks({ set: [{ name: 'X' }] }))
      .toThrow(/pass one current trackId or index/i);
    expect(() => ctrl.manageTracks({ reorder: [{ to: 0 }] }))
      .toThrow(/pass one current trackId or index/i);
  });

  it('refuses empty instructions, no-op sets add no history', () => {
    const ctrl = new EditorController();
    expect(() => ctrl.manageTracks({})).toThrow(/nothing to do/i);
    expect(() => ctrl.manageTracks({ set: [] })).toThrow(/nothing to do/i);
    expect(() => ctrl.manageTracks({ set: [{ trackId: 'v1' }] }))
      .toThrow(/at least one of muted, hidden, syncLocked, name/i);

    const receipt = ctrl.manageTracks({ set: [{ trackId: 'v1', muted: false }] });
    expect(receipt).toBeNull(); // already visible — nothing changed
  });

  it('refuses removing non-empty tracks and the last of a type', () => {
    const ctrl = new EditorController();
    ctrl.addClip({
      assetId: (() => {
        ctrl.addMedia({
          id: 'asset-1',
          path: '/test/v.mp4',
          filename: 'v.mp4',
          type: 'video',
          duration: 100,
          fileSize: 1,
          addedAt: new Date().toISOString(),
        });
        return 'asset-1';
      })(),
      trackId: 'v1',
      startFrame: 0,
    });

    expect(() => ctrl.manageTracks({ remove: ['v1'] })).toThrow(/still has 1 clip/i);

    // An empty track removes fine...
    const v2 = ctrl.addTrack('video', 'Video 2');
    const receipt = ctrl.manageTracks({ remove: [v2] });
    expect(receipt?.removedTracks).toEqual([
      { trackId: v2, label: 'Video 2', type: 'video' },
    ]);

    // ...but the last EMPTY track of a type is still protected.
    expect(() => ctrl.manageTracks({ remove: ['a1'] })).toThrow(/last audio track/i);
  });

  it('reports the final order with indices in the receipt', () => {
    const ctrl = new EditorController();
    const v2 = ctrl.addTrack('video', 'Video 2');

    const receipt = ctrl.manageTracks({ reorder: [{ trackId: v2, to: 0 }] });
    expect(receipt?.tracks[0].trackId).toBe(v2);
    // Per-type renumbering: the video zone's own order values (2 then 1)
    // follow the new array sequence, so the list head stays the top layer.
    // The untouched audio zone keeps its exact original value.
    expect(ctrl.getTracks().map((t) => t.order)).toEqual([2, 1, 0]);
  });
});
