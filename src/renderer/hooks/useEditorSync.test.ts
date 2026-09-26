import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyProject } from '../../shared/types/project';
import { useTimelineStore } from '../store/timeline';
import { adoptRendererState } from './useEditorSync';

beforeEach(() => {
  useTimelineStore.getState().controller.loadProject(createEmptyProject('Local'));
});

describe('renderer-origin adoption', () => {
  it('replaces project state without adding an undo entry or notifying sync subscribers', () => {
    const controller = useTimelineStore.getState().controller;
    controller.addTrack('video', 'Local edit');
    const remote = createEmptyProject('Remote edit');
    let notifications = 0;
    const unsubscribe = controller.subscribe(() => {
      notifications += 1;
    });

    adoptRendererState(remote);

    expect(controller.getProject().name).toBe('Remote edit');
    expect(useTimelineStore.getState().project.name).toBe('Remote edit');
    expect(controller.canUndo()).toBe(true);
    expect(notifications).toBe(0);

    unsubscribe();
    expect(controller.undo()).toBe(true);
    expect(controller.getTracks()).toHaveLength(2);
  });
});
