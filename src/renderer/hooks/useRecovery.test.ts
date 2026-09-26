import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorController } from '../../shared/editor/controller';
import { createEmptyProject } from '../../shared/types/project';
import { useProjectStore } from '../store/project';
import { useTimelineStore } from '../store/timeline';
import {
  applyRecoverySnapshot,
  discardRecoverySnapshot,
  restoreRecoverySnapshot,
  recoveryRestoreFeedback,
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

    expect(restored).toBe('restored');
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

/**
 * A Restore is two steps — apply to the editor, then persist a copy elsewhere —
 * and each can fail on its own. Reporting them as one boolean is what let a
 * persist failure read as a restore that never happened, over a project the user
 * could see loading.
 */
describe('restore outcome is reported per step', () => {
  it('reports applied-and-persisted as a clean restore', async () => {
    const outcome = await restoreRecoverySnapshot(recoveryCandidate);

    expect(outcome).toBe('restored');
    expect(recoveryRestoreFeedback(outcome)).toEqual({
      error: null,
      applied: true,
      awaitingDecision: false,
    });
  });

  it('reports applied-but-not-persisted without claiming the restore failed', async () => {
    autosave.mockResolvedValue({ success: false, error: 'EPERM' });

    const outcome = await restoreRecoverySnapshot(recoveryCandidate);

    // The project is in the editor: the apply ran before the persist was tried.
    expect(outcome).toBe('restored-not-persisted');
    expect(useTimelineStore.getState().controller.getProject().name).toBe('Recovered name');
    expect(useProjectStore.getState().isLoaded).toBe(true);
    // The orphan is the only durable copy left, so it is kept.
    expect(clearRecovery).not.toHaveBeenCalled();

    const feedback = recoveryRestoreFeedback(outcome);
    expect(feedback.error).toBe(
      'The project was restored, but saving a copy of it failed; the original snapshot was kept.',
    );
    expect(feedback.applied).toBe(true);
    // The prompt must not stay up: its Discard button would now throw away the
    // open project, and the recovered project is already on screen.
    expect(feedback.awaitingDecision).toBe(false);
  });

  it('reports not-applied and keeps the decision open', async () => {
    const outcome = await restoreRecoverySnapshot({
      ...recoveryCandidate,
      snapshot: { ...recoveryCandidate.snapshot, data: '{"name":"not a project"}' },
    });

    expect(outcome).toBe('not-applied');
    expect(autosave).not.toHaveBeenCalled();
    expect(clearRecovery).not.toHaveBeenCalled();
    expect(useProjectStore.getState().isLoaded).toBe(false);

    const feedback = recoveryRestoreFeedback(outcome);
    expect(feedback.error).toBe(
      'The recovery snapshot could not be opened, so the project was not restored; the original snapshot was kept.',
    );
    expect(feedback.applied).toBe(false);
    // Nothing changed, so Restore and Discard are both still meaningful.
    expect(feedback.awaitingDecision).toBe(true);
  });

  it('treats a leftover orphan after a successful persist as a completed restore', async () => {
    clearRecovery.mockResolvedValue({ success: false, error: 'EPERM' });

    const outcome = await restoreRecoverySnapshot(recoveryCandidate);

    // Applied and persisted: the project is safe, and the retained file is just
    // one more recovery point for the next launch.
    expect(outcome).toBe('restored');
    expect(recoveryRestoreFeedback(outcome)).toEqual({
      error: null,
      applied: true,
      awaitingDecision: false,
    });
  });
});
