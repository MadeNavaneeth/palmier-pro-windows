import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorController } from '../../shared/editor/controller';
import { createEmptyProject } from '../../shared/types/project';
import { useProjectStore } from '../store/project';
import { useTimelineStore } from '../store/timeline';
import {
  applyRecoverySnapshot,
  discardRecoverySnapshot,
  restoreRecoverySnapshot,
  type RecoveryCandidate,
} from './useRecovery';

const recoveryId = 'crashed-session';
const recoveryCandidate: RecoveryCandidate = {
  recoveryId,
  snapshot: {
    savedAt: '2026-01-02T12:00:00.000Z',
    projectFilePath: 'C:/Projects/recovered.vproj',
    projectName: 'Recovered name',
    data: JSON.stringify(createEmptyProject('Serialized name')),
  },
};

const clearRecovery = vi.fn();
const autosave = vi.fn();

beforeEach(() => {
  clearRecovery.mockReset().mockResolvedValue({ success: true });
  autosave.mockReset().mockResolvedValue({ success: true });
  vi.stubGlobal('window', {
    palmier: {
      project: {
        autosave,
        recoveryClear: clearRecovery,
      },
    },
  });
  useTimelineStore.setState({
    controller: new EditorController(),
    project: new EditorController().getProject(),
  });
  useProjectStore.setState({
    name: 'Untitled Project',
    filePath: null,
    isLoaded: false,
    hasUnsavedChanges: false,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('recovery renderer actions', () => {
  it('restores the snapshot through the project controller and clears the orphan', async () => {
    const restored = await restoreRecoverySnapshot(recoveryCandidate);

    expect(restored).toBe(true);
    expect(useTimelineStore.getState().controller.getProject().name).toBe('Recovered name');
    expect(useProjectStore.getState()).toMatchObject({
      name: 'Recovered name',
      filePath: 'C:/Projects/recovered.vproj',
      isLoaded: true,
      hasUnsavedChanges: true,
    });
    expect(autosave).toHaveBeenCalledWith(
      'Recovered name',
      'C:/Projects/recovered.vproj',
      expect.stringContaining('Recovered name'),
    );
    expect(clearRecovery).toHaveBeenCalledWith(recoveryId);
  });

  it('discard removes the selected orphan without changing the project', async () => {
    const before = useTimelineStore.getState().controller.getProject();
    const discarded = await discardRecoverySnapshot(recoveryId);

    expect(discarded).toBe(true);
    expect(useTimelineStore.getState().controller.getProject()).toBe(before);
    expect(clearRecovery).toHaveBeenCalledWith(recoveryId);
  });

  it('rejects hostile data before it can reach the controller', () => {
    const applied = applyRecoverySnapshot({
      ...recoveryCandidate.snapshot,
      data: '{"name":"not a project"}',
    });

    expect(applied).toBe(false);
    expect(clearRecovery).not.toHaveBeenCalled();
    expect(useTimelineStore.getState().controller.getProject().name).not.toBe('Recovered name');
  });
});
