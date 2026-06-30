import { describe, it, expect } from 'vitest';
import { EditorController } from './controller';
import { createEmptyProject } from '../types/project';

describe('controller sync primitives', () => {
  it('setProjectSilent replaces state without notifying or touching history', () => {
    const ctrl = new EditorController();
    let notified = 0;
    ctrl.subscribe(() => { notified++; });

    const other = createEmptyProject('Mirrored');
    other.settings.fps = 24;
    ctrl.setProjectSilent(other);

    expect(ctrl.getProject().name).toBe('Mirrored');
    expect(ctrl.getProject().settings.fps).toBe(24);
    expect(notified).toBe(0); // no subscriber churn / no sync echo
    expect(ctrl.canUndo()).toBe(false); // history untouched
  });

  it('adoptProject applies an external edit as one undoable, notifying step', () => {
    const ctrl = new EditorController();
    let notified = 0;
    ctrl.subscribe(() => { notified++; });

    const edited = createEmptyProject('Agent Result');
    edited.timeline.clips.push({
      id: 'c1', assetId: 'a1', type: 'video', trackId: 'v1',
      startFrame: 0, durationFrames: 50, inPoint: 0, outPoint: 50,
      x: 0, y: 0, width: 1920, height: 1080, rotation: 0, scaleX: 1, scaleY: 1,
      opacity: 1, anchorX: 0, anchorY: 0, volume: 1, muted: false,
    });

    ctrl.adoptProject(edited, 'AI edit');
    expect(notified).toBe(1);
    expect(ctrl.getClips()).toHaveLength(1);
    expect(ctrl.canUndo()).toBe(true);

    // The UI can reverse the agent edit in one step.
    ctrl.undo();
    expect(ctrl.getClips()).toHaveLength(0);
  });

  it('round-trips an adopted edit through serialization', () => {
    const ctrl = new EditorController();
    const edited = createEmptyProject('X');
    edited.settings.width = 1280;
    ctrl.adoptProject(edited);
    const restored = EditorController.deserialize(ctrl.serialize());
    expect(restored.getProject().settings.width).toBe(1280);
  });
});
