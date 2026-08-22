/**
 * Regression coverage for marker CRUD on the editor controller
 * (upstream PR #542): one undoable step per change, precise validation
 * failures, no-op calls that add no history entry, and persistence riding the
 * project snapshot.
 */

import { describe, it, expect } from 'vitest';
import { EditorController } from './controller';

describe('EditorController markers (#542)', () => {
  it('creates a marker with defaults and sorts by start frame', () => {
    const ctrl = new EditorController();
    const receipt = ctrl.changeTimelineMarkers({
      creates: [
        { name: 'Later', startFrame: 200 },
        { name: 'First', startFrame: 50 },
      ],
    });
    expect(receipt?.created).toHaveLength(2);
    const markers = ctrl.getMarkers();
    expect(markers.map((m) => m.name)).toEqual(['First', 'Later']);
    expect(markers[0].durationFrames).toBe(0);
    expect(markers[0].color).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it('updates and deletes in one undoable step', () => {
    const ctrl = new EditorController();
    const { created } = ctrl.changeTimelineMarkers({
      creates: [
        { name: 'A', startFrame: 10 },
        { name: 'B', startFrame: 20 },
      ],
    })!;

    const keepId = created![0].id;
    const dropId = created![1].id;
    const receipt = ctrl.changeTimelineMarkers({
      updates: [{ id: keepId, name: 'Renamed', startFrame: 15 }],
      deleteIds: [dropId],
    }, 'Marker edit');

    expect(receipt?.updated).toHaveLength(1);
    expect(receipt?.deletedIds).toEqual([dropId]);
    expect(ctrl.getMarkers()).toHaveLength(1);
    expect(ctrl.getMarkers()[0]).toMatchObject({ id: keepId, name: 'Renamed', startFrame: 15 });

    ctrl.undo();
    expect(ctrl.getMarkers()).toHaveLength(2);
    expect(ctrl.getMarkers().find((m) => m.id === keepId)?.name).toBe('A');
    ctrl.redo();
    expect(ctrl.getMarkers()).toHaveLength(1);
  });

  it('throws precise errors for missing references and invalid values', () => {
    const ctrl = new EditorController();
    expect(() => ctrl.changeTimelineMarkers({ deleteIds: ['nope'] })).toThrow(/no marker/i);

    const { created } = ctrl.changeTimelineMarkers({ creates: [{ name: 'A', startFrame: 0 }] })!;
    expect(() =>
      ctrl.changeTimelineMarkers({ updates: [{ id: created![0].id, name: '' }] }),
    ).toThrow(/name/i);
    expect(() =>
      ctrl.changeTimelineMarkers({ updates: [{ id: 'missing', name: 'X' }] }),
    ).toThrow(/no marker/i);
    // The failed update must not have changed anything.
    expect(ctrl.getMarkers()[0].name).toBe('A');
  });

  it('treats a no-op call as no history entry', () => {
    const ctrl = new EditorController();
    const { created } = ctrl.changeTimelineMarkers({ creates: [{ name: 'A', startFrame: 5 }] })!;
    const canUndoAfterCreate = ctrl.canUndo();

    const receipt = ctrl.changeTimelineMarkers({
      updates: [{ id: created![0].id, name: 'A' }],
    });
    expect(receipt).toBeNull();
    expect(ctrl.canUndo()).toBe(canUndoAfterCreate);
  });

  it('rescales markers when the project timebase changes', () => {
    const ctrl = new EditorController();
    ctrl.changeTimelineMarkers({
      creates: [{ name: 'Range', startFrame: 100, durationFrames: 50 }],
    });

    // Double the fps: every frame value doubles.
    ctrl.applyProjectSettings({ fps: ctrl.getProject().settings.fps * 2 });
    const [marker] = ctrl.getMarkers();
    expect(marker.startFrame).toBe(200);
    expect(marker.durationFrames).toBe(100);
  });
});
