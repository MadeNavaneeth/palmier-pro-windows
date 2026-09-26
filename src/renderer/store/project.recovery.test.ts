import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorController } from '../../shared/editor/controller';
import { createEmptyProject } from '../../shared/types/project';
import { useProjectStore } from './project';
import { useTimelineStore } from './timeline';

const saveProject = vi.fn();
const clearRecovery = vi.fn();

beforeEach(() => {
  saveProject.mockReset().mockResolvedValue({ success: true, path: 'C:/Projects/saved.vproj' });
  clearRecovery.mockReset().mockResolvedValue({ success: true });
  vi.stubGlobal('window', {
    palmier: {
      project: {
        save: saveProject,
        recoveryClear: clearRecovery,
      },
    },
  });
  useProjectStore.setState({
    name: 'Saved project',
    filePath: null,
    isLoaded: true,
    hasUnsavedChanges: true,
  });
  const controller = new EditorController(createEmptyProject('Saved project'));
  useTimelineStore.setState({
    controller,
    project: controller.getProject(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('explicit save recovery lifecycle', () => {
  it('clears the current session snapshot after a successful save', async () => {
    await useProjectStore.getState().save();

    expect(saveProject).toHaveBeenCalledOnce();
    expect(clearRecovery).toHaveBeenCalledWith();
    expect(useProjectStore.getState().hasUnsavedChanges).toBe(false);
  });

  it('does not clear recovery when the real save fails', async () => {
    saveProject.mockResolvedValue({ success: false, error: 'disk full' });

    await expect(useProjectStore.getState().save()).rejects.toThrow('disk full');
    expect(clearRecovery).not.toHaveBeenCalled();
  });
});
