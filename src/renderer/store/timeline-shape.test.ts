/**
 * Store-level shape creation and the direct-manipulation gesture protocol.
 *
 * `addShapeAtPlayhead` mirrors `addTitleAtPlayhead` (one undoable add,
 * selected on success, refusal leaves selection alone). The gesture cases pin
 * the commit pattern `ShapeOverlay` uses: every transient step undoes the
 * previous one before reapplying, so a whole drag occupies ONE history entry,
 * and an unchanged-ending apply (press that never really moved) pushes none.
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

describe('transform gesture commit protocol', () => {
  /** One pointermove step: undo the previous transient, reapply from the
   * start snapshot + total delta — the pattern ShapeOverlay drives. */
  function gestureStep(
    controller: ReturnType<typeof useTimelineStore.getState>['controller'],
    clipId: string,
    hasApplied: boolean,
    mutate: (draft: { x: number; y?: number }) => void,
    label: string,
  ): boolean {
    if (hasApplied) controller.undo();
    const report = controller.applyClipProperties([clipId], label, (draft) => {
      mutate(draft);
      return true;
    });
    return report.changedClipIds.length > 0;
  }

  it('keeps a whole multi-step move to one history entry that restores the start', () => {
    const { store, controller } = freshStore();
    const clipId = store.getState().addShapeAtPlayhead('rect');
    const startX = clipById(controller, clipId)!.x;

    let hasApplied = false;
    for (const dx of [10, 25, 40]) {
      hasApplied = gestureStep(
        controller,
        clipId,
        hasApplied,
        (draft) => {
          draft.x = startX + dx;
        },
        'Move shape',
      );
    }
    expect(hasApplied).toBe(true);
    expect(clipById(controller, clipId)!.x).toBe(startX + 40);

    // The drag occupied exactly one entry: one undo restores the start
    // position, the next undo removes the add that preceded the drag.
    controller.undo();
    expect(clipById(controller, clipId)!.x).toBe(startX);
    controller.undo();
    expect(clipById(controller, clipId)).toBeUndefined();
  });

  it('ends a press that never moved with no history entry at all', () => {
    const { store, controller } = freshStore();
    const clipId = store.getState().addShapeAtPlayhead('rect');
    const startX = clipById(controller, clipId)!.x;
    const startY = clipById(controller, clipId)!.y;

    // Delta rounds to 0 → draft equals the stored clip → no command, no entry.
    const applied = gestureStep(
      controller,
      clipId,
      false,
      (draft) => {
        draft.x = startX + Math.round(0.4);
        draft.y = startY + Math.round(-0.4);
      },
      'Move shape',
    );
    expect(applied).toBe(false);

    // History still holds only the add: one undo removes the clip outright.
    controller.undo();
    expect(clipById(controller, clipId)).toBeUndefined();
  });
});
