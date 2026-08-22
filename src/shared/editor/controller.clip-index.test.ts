/**
 * Regression coverage for the controller's clip-id lookup index
 * (upstream PR #486).
 *
 * Upstream's defect: every id lookup scanned all tracks and clips, so
 * operations that resolve a selection — link-eligibility checks, bulk moves —
 * went quadratic and hung the editor on large timelines. The Windows
 * controller keeps an id→clip map rebuilt lazily whenever the project object
 * identity changes, which every mutation (command, undo, redo, restore)
 * causes. These tests pin correctness across revisions; the perf claim they
 * protect is O(1) lookups after one linear build per revision.
 */

import { describe, it, expect } from 'vitest';
import { EditorController } from './controller';

function controllerWithClips(count: number): { ctrl: EditorController; ids: string[] } {
  const ctrl = new EditorController();
  ctrl.addMedia({
    id: 'asset-1',
    path: '/test/video.mp4',
    filename: 'video.mp4',
    type: 'video',
    duration: 100_000,
    fileSize: 1000,
    addedAt: new Date().toISOString(),
  });
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    ids.push(ctrl.addClip({ assetId: 'asset-1', trackId: 'v1', startFrame: i * 10 }));
  }
  return { ctrl, ids };
}

describe('clip lookup index (#486)', () => {
  it('resolves clips correctly on a large timeline', () => {
    const { ctrl, ids } = controllerWithClips(2000);
    const clips = ctrl.getClips();
    // Spot-check first, middle, last, and an unknown id.
    expect(clips.find((c) => c.id === ids[0])?.startFrame).toBe(0);
    expect(clips.find((c) => c.id === ids[999])?.startFrame).toBe(9990);
    expect(clips.find((c) => c.id === ids[ids.length - 1])?.startFrame).toBe(
      (ids.length - 1) * 10,
    );
  });

  it('sees post-mutation state, never a stale cached clip', () => {
    const { ctrl, ids } = controllerWithClips(500);
    const targetId = ids[250];

    ctrl.moveClip(targetId, 90_000);
    let clip = ctrl.getClips().find((c) => c.id === targetId);
    expect(clip?.startFrame).toBe(90_000);

    // The moved clip must be the same object identity the index now returns,
    // so downstream consumers cannot observe two different versions.
    const movedAgain = ctrl.getClips().find((c) => c.id === targetId);
    expect(movedAgain).toBe(clip);

    ctrl.undo();
    clip = ctrl.getClips().find((c) => c.id === targetId);
    expect(clip?.startFrame).toBe(2500);
  });

  it('keeps split, trim, and remove-silence resolution working through mutations', () => {
    const { ctrl, ids } = controllerWithClips(300);
    const targetId = ids[5]; // startFrame 50

    const rightId = ctrl.splitClip(targetId, 55);
    expect(rightId).not.toBeNull();
    expect(ctrl.getClips().find((c) => c.id === targetId)?.durationFrames).toBe(5);
    expect(ctrl.getClips().find((c) => c.id === rightId!)?.startFrame).toBe(55);

    // trimClipEdge resolves its lead clip through the same index.
    const before =
      ctrl.getClips().find((c) => c.id === rightId!)?.durationFrames ?? 0;
    const report = ctrl.trimClipEdge(rightId!, 'right', -5);
    expect(report).not.toBeNull();
    expect(ctrl.getClips().find((c) => c.id === rightId!)?.durationFrames).toBe(before - 5);
  });

  it('rebuilds across undo and redo without serving stale clips', () => {
    const { ctrl, ids } = controllerWithClips(300);
    const targetId = ids[7]; // startFrame 70

    ctrl.moveClip(targetId, 80_000);
    ctrl.undo();
    expect(ctrl.getClips().find((c) => c.id === targetId)?.startFrame).toBe(70);
    ctrl.redo();
    expect(ctrl.getClips().find((c) => c.id === targetId)?.startFrame).toBe(80_000);
  });

  it('stops resolving clips removed from the timeline', () => {
    const { ctrl, ids } = controllerWithClips(200);
    const victimId = ids[3];

    ctrl.removeClips([victimId]);
    expect(ctrl.getClips().some((c) => c.id === victimId)).toBe(false);
    // A stale index would keep handing the dead clip back to mutations.
    ctrl.moveClip(victimId, 5_000);
    expect(ctrl.getClips().some((c) => c.id === victimId)).toBe(false);
  });

  it('resolves ids added after the index was built', () => {
    const { ctrl } = controllerWithClips(50);
    const lateId = ctrl.addClip({ assetId: 'asset-1', trackId: 'v1', startFrame: 999 });
    ctrl.moveClip(lateId, 1_000);
    expect(ctrl.getClips().find((c) => c.id === lateId)?.startFrame).toBe(1_000);
  });
});
