/**
 * Store-level shape creation and the property path a shape gesture rides.
 *
 * `addShapeAtPlayhead` mirrors `addTitleAtPlayhead` (one undoable add,
 * selected on success, refusal leaves selection alone). The second block pins
 * the store contract the direct-manipulation gesture depends on: a changed
 * draft is exactly one undo entry, and an unchanged one adds none — which is
 * what lets a press that never really moved stay off the history.
 *
 * The gesture's own frame protocol (preview, collapse, commit once) is not
 * re-implemented here. It is tested where it lives, against the functions the
 * overlay ships: `components/preview/shape-overlay-gesture-history.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import { useTimelineStore } from './timeline';

/** Drive the real store; each test seeds its own clips through the controller. */
function freshStore() {
  const store = useTimelineStore;
  const controller = store.getState().controller;
  return { store, controller };
}

function clipById(
  controller: ReturnType<typeof useTimelineStore.getState>['controller'],
  id: string,
) {
  return controller.getClips().find((clip) => clip.id === id);
}

describe('addShapeAtPlayhead', () => {
  it('adds a 3s shape at the playhead on the first video track and selects it', () => {
    const { store, controller } = freshStore();
    controller.setPlayhead(90);

    const clipId = store.getState().addShapeAtPlayhead('arrow');
    expect(clipId).not.toBe('');
    const clip = clipById(controller, clipId)!;
    expect(clip.type).toBe('shape');
    expect(clip.shapeKind).toBe('arrow');
    expect(clip.startFrame).toBe(90);
    expect(clip.durationFrames).toBe(Math.round(controller.getProject().settings.fps * 3));
    expect(store.getState().selectedClipIds).toEqual(new Set([clipId]));
    expect(store.getState().selectedGap).toBeNull();

    // One undoable step: a single undo removes the add.
    controller.undo();
    expect(clipById(controller, clipId)).toBeUndefined();
  });

  it('refuses a locked track and leaves the current selection untouched', () => {
    const { store, controller } = freshStore();
    const existing = store.getState().addShapeAtPlayhead('rect');
    expect(existing).not.toBe('');
    controller.setTrackLocked('v1', true);

    expect(store.getState().addShapeAtPlayhead('ellipse')).toBe('');
    expect(store.getState().selectedClipIds).toEqual(new Set([existing]));
    expect(controller.getClips()).toHaveLength(1);
    controller.setTrackLocked('v1', false);
  });
});

describe('transform gesture store contract', () => {
  /** One gesture frame's property write, exactly as the overlay applies it. */
  function shapeStep(
    controller: ReturnType<typeof useTimelineStore.getState>['controller'],
    clipId: string,
    draft: (clip: { x: number; y: number }) => void,
  ): boolean {
    const report = controller.applyClipProperties([clipId], 'Move shape', (clip) => {
      draft(clip);
      return true;
    });
    return report.changedClipIds.length > 0;
  }

  it('adds one history entry per changed draft and reports what it changed', () => {
    const { store, controller } = freshStore();
    const clipId = store.getState().addShapeAtPlayhead('rect');
    const startX = clipById(controller, clipId)!.x;

    expect(shapeStep(controller, clipId, (clip) => {
      clip.x = startX + 40;
    })).toBe(true);
    expect(clipById(controller, clipId)!.x).toBe(startX + 40);
    expect(controller.getLastCommandDescription()).toBe('setClipProperties');

    // One undo reverts the whole write: the gesture publishes this once, at
    // release, and re-derives every frame from its own start snapshot.
    expect(controller.undo()).toBe(true);
    expect(clipById(controller, clipId)!.x).toBe(startX);
  });

  it('adds no history entry for a draft equal to the stored clip', () => {
    const { store, controller } = freshStore();
    const clipId = store.getState().addShapeAtPlayhead('rect');
    const startX = clipById(controller, clipId)!.x;
    const startY = clipById(controller, clipId)!.y;

    // A pointer delta that rounds to nothing leaves the draft unchanged, so the
    // controller skips it. That is what makes a press that never really moved
    // stage no frame and publish no entry.
    expect(shapeStep(controller, clipId, (clip) => {
      clip.x = startX + Math.round(0.4);
      clip.y = startY + Math.round(-0.4);
    })).toBe(false);

    // History still holds only the add: one undo removes the clip outright.
    expect(controller.undo()).toBe(true);
    expect(clipById(controller, clipId)).toBeUndefined();
  });
});
