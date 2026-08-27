/**
 * Comping / compact take (upstream PR #428):
 * - Creates a comp track on first use
 * - Copies the overlapping source segment onto the comp track
 * - Re-compacting the same range overwrites (removes old comp clips first)
 * - One undo step for the whole operation
 * - Source offset is correct when range starts mid-clip
 * - Fails gracefully on missing range, missing clip, or no overlap
 */

import { describe, it, expect } from 'vitest';
import { EditorController } from './controller';

function project() {
  const ctrl = new EditorController();
  ctrl.addMedia({
    id: 'av', path: '/v.mp4', filename: 'v.mp4', type: 'video',
    duration: 2000, fileSize: 1, audioCodec: 'aac', addedAt: new Date().toISOString(),
  });
  ctrl.addMedia({
    id: 'av2', path: '/v2.mp4', filename: 'v2.mp4', type: 'video',
    duration: 2000, fileSize: 1, addedAt: new Date().toISOString(),
  });
  // Two takes on separate video tracks
  const takeBTrackId = ctrl.addTrack('video', 'Take B');
  ctrl.placeMediaAssets(['av'], 'v1', 0);
  ctrl.placeMediaAssets(['av2'], takeBTrackId, 0);
  return ctrl;
}

describe('compactTake (upstream PR #428)', () => {
  it('returns false when no range is set', () => {
    const ctrl = project();
    const clips = ctrl.getClips();
    expect(ctrl.compactTake(clips[0].id)).toBe(false);
  });

  it('returns false for a nonexistent clip id', () => {
    const ctrl = project();
    ctrl.setMarkedRange(100, 300);
    expect(ctrl.compactTake('nonexistent')).toBe(false);
  });

  it('returns false when source clip does not overlap the range', () => {
    const ctrl = project();
    ctrl.setMarkedRange(500, 600); // range far from clip at 0-2000
    const clips = ctrl.getClips().filter((c) => c.type === 'video');
    // Clip starts at 0, duration ~2000, range 500-600 does overlap
    // Need a clip that doesn't overlap — use a different approach
    // Place a clip at frame 800 and mark a range at 0-100
    ctrl.addClip({ assetId: 'av', trackId: 'v1', startFrame: 800, durationFrames: 100 });
    ctrl.clearMarkedRange();
    ctrl.setMarkedRange(0, 50); // range 0-50, far from clip at 800-900
    const shortClip = ctrl.getClips().find((c) => c.startFrame === 800)!;
    expect(ctrl.compactTake(shortClip.id)).toBe(false);
  });

  it('creates a comp track and places the segment on first use', () => {
    const ctrl = project();
    ctrl.setMarkedRange(100, 300);
    const clips = ctrl.getClips().filter((c) => c.type === 'video');
    const sourceClip = clips[0]; // first video clip at 0-2000

    const result = ctrl.compactTake(sourceClip.id);
    expect(result).toBe(true);

    // Comp track should exist
    const tracks = ctrl.getTracks();
    const compTrack = tracks.find((t) => t.name === 'Comp');
    expect(compTrack).toBeDefined();

    // One comp clip should exist on the comp track
    const compClips = ctrl.getClips().filter((c) => c.trackId === compTrack!.id);
    expect(compClips).toHaveLength(1);
    expect(compClips[0].startFrame).toBe(100);
    expect(compClips[0].durationFrames).toBe(200); // 300 - 100
    expect(compClips[0].assetId).toBe(sourceClip.assetId);
  });

  it('re-compacting overwrites the previous comp clip in the range', () => {
    const ctrl = project();
    ctrl.setMarkedRange(100, 300);
    // Capture the two original take clip ids before any comp action.
    const takeA = ctrl.getClips().find((c) => c.assetId === 'av' && c.type === 'video')!.id;
    const takeB = ctrl.getClips().find((c) => c.assetId === 'av2' && c.type === 'video')!.id;

    // Compact Take A
    ctrl.compactTake(takeA);
    // Compact Take B over the same range
    ctrl.compactTake(takeB);

    const compTrack = ctrl.getTracks().find((t) => t.name === 'Comp')!;
    const compClips = ctrl.getClips().filter((c) => c.trackId === compTrack.id);
    // Should be exactly 1 comp clip (the second one overwrote the first)
    expect(compClips).toHaveLength(1);
    expect(compClips[0].assetId).toBe('av2');
  });

  it('source offset is correct when range starts mid-clip', () => {
    const ctrl = project();
    ctrl.setMarkedRange(200, 500); // range starts at 200, clip starts at 0
    const clips = ctrl.getClips().filter((c) => c.type === 'video');
    ctrl.compactTake(clips[0].id);

    const compTrack = ctrl.getTracks().find((t) => t.name === 'Comp')!;
    const compClip = ctrl.getClips().find((c) => c.trackId === compTrack.id)!;
    // Source offset = 200 (overlapStart) - 0 (clip.startFrame) = 200
    expect(compClip.inPoint).toBe(clips[0].inPoint + 200);
    expect(compClip.outPoint).toBe(clips[0].inPoint + 500);
  });

  it('compacting is one undo step', () => {
    const ctrl = project();
    ctrl.setMarkedRange(100, 300);
    const clips = ctrl.getClips().filter((c) => c.type === 'video');
    const before = ctrl.canUndo();

    ctrl.compactTake(clips[0].id);
    expect(ctrl.canUndo()).toBe(true);

    ctrl.undo();
    // After undo, comp track and clips should be gone
    const compTrack = ctrl.getTracks().find((t) => t.name === 'Comp');
    expect(compTrack).toBeUndefined();
  });

  it('comp track survives serialization', () => {
    const ctrl = project();
    ctrl.setMarkedRange(100, 300);
    const clips = ctrl.getClips().filter((c) => c.type === 'video');
    ctrl.compactTake(clips[0].id);

    const json = ctrl.serialize();
    const restored = new EditorController(JSON.parse(json));
    const compTrack = restored.getTracks().find((t) => t.name === 'Comp');
    expect(compTrack).toBeDefined();
    const compClips = restored.getClips().filter((c) => c.trackId === compTrack!.id);
    expect(compClips).toHaveLength(1);
  });
});
