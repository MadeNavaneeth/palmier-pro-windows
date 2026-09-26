/**
 * useRecovery — the renderer half of crash recovery.
 *
 * The main process returns one validated orphan snapshot. This hook keeps the
 * decision explicit, applies the project through the same controller path as
 * an ordinary open, and only then removes the selected orphan file.
 */

import { useCallback, useEffect, useState } from 'react';
import { EditorController } from '../../shared/editor/controller';
import type { Project } from '../../shared/types/project';
import { useProjectStore } from '../store/project';
import { useTimelineStore } from '../store/timeline';

export interface RecoverySnapshot {
  savedAt: string;
  projectFilePath: string | null;
  projectName: string;
  data: string;
}

export interface RecoveryCandidate {
  recoveryId: string;
  snapshot: RecoverySnapshot;
}

const RECOVERY_ID_RE = /^[A-Za-z0-9_-]+$/;
const MAX_RECOVERY_DATA_LENGTH = 128 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProjectDocument(value: unknown): boolean {
  if (!isRecord(value) || typeof value.name !== 'string') return false;
  const timeline = value.timeline;
  return isRecord(value.settings)
    && Array.isArray(value.media)
    && isRecord(timeline)
    && Array.isArray(timeline.tracks)
    && Array.isArray(timeline.clips);
}

function isRecoverySnapshot(value: unknown): value is RecoverySnapshot {
  if (!isRecord(value)) return false;
  if (typeof value.savedAt !== 'string' || !Number.isFinite(Date.parse(value.savedAt))) {
    return false;
  }
  if (typeof value.projectName !== 'string' || value.projectName.length > 512) return false;
  if (
    value.projectFilePath !== null
    && (
      typeof value.projectFilePath !== 'string'
      || value.projectFilePath.length > 4096
      || value.projectFilePath.includes('\0')
    )
  ) {
    return false;
  }
  if (typeof value.data !== 'string' || value.data.length > MAX_RECOVERY_DATA_LENGTH) {
    return false;
  }
  try {
    return isProjectDocument(JSON.parse(value.data));
  } catch {
    return false;
  }
}

/** Narrow the untrusted IPC response before it can reach the editor. */
function recoveryCandidateFromResponse(value: unknown): RecoveryCandidate | null {
  if (!isRecord(value) || value.hasRecovery !== true) return null;
  if (typeof value.recoveryId !== 'string' || !RECOVERY_ID_RE.test(value.recoveryId)) {
    return null;
  }
  if (!isRecoverySnapshot(value.snapshot)) return null;
  return {
    recoveryId: value.recoveryId,
    snapshot: value.snapshot,
  };
}

/** Parse through the same migration/deserialization path as a project open. */
export function parseRecoveryProject(snapshot: RecoverySnapshot): Project {
  if (!isRecoverySnapshot(snapshot)) {
    throw new Error('Recovery snapshot is not a valid project document.');
  }
  const project = EditorController.deserialize(snapshot.data).getProject();
  if (!isProjectDocument(project)) {
    throw new Error('Recovery project is not a valid project document.');
  }
  const name = snapshot.projectName.trim() || project.name || 'Recovered Project';
  return { ...project, name };
}

/** Apply a validated snapshot to the authoritative renderer controller. */
export function applyRecoverySnapshot(snapshot: RecoverySnapshot): boolean {
  try {
    const project = parseRecoveryProject(snapshot);
    useTimelineStore.getState().loadProject(project);
    useProjectStore.setState({
      name: project.name,
      filePath: snapshot.projectFilePath,
      isLoaded: true,
      // A recovery is deliberately dirty until the user explicitly saves it.
      hasUnsavedChanges: true,
    });
    return true;
  } catch {
    return false;
  }
}

async function persistRestoredSnapshot(): Promise<boolean> {
  try {
    const controller = useTimelineStore.getState().controller;
    const { name, filePath } = useProjectStore.getState();
    const result = await window.palmier.project.autosave(
      name,
      filePath,
      controller.serialize(),
    );
    return result?.success !== false;
  } catch {
    return false;
  }
}

async function clearRecoverySnapshot(recoveryId: string): Promise<boolean> {
  try {
    const result = await window.palmier.project.recoveryClear(recoveryId);
    return result?.success !== false;
  } catch {
    return false;
  }
}

/** Testable action helper: apply first, then remove the handled orphan. */
export async function restoreRecoverySnapshot(
  candidate: RecoveryCandidate,
): Promise<boolean> {
  if (!applyRecoverySnapshot(candidate.snapshot)) return false;
  // Do not remove the orphan until the restored state has a replacement in
  // this session's file. That closes the crash window between Restore and the
  // next debounced autosave tick.
  if (!(await persistRestoredSnapshot())) return false;
  return clearRecoverySnapshot(candidate.recoveryId);
}

/** Testable action helper: remove the selected orphan without touching state. */
export function discardRecoverySnapshot(recoveryId: string): Promise<boolean> {
  return clearRecoverySnapshot(recoveryId);
}

export function useRecovery() {
  const [candidate, setCandidate] = useState<RecoveryCandidate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve()
      .then(() => window.palmier.project.recoveryCheck())
      .then((result: unknown) => {
        if (cancelled) return;
        const found = recoveryCandidateFromResponse(result);
        if (found) setCandidate(found);
      })
      .catch(() => {
        // Recovery is best effort at startup; the editor remains usable if the
        // bridge or the userData directory is unavailable.
        if (!cancelled) setError('Could not check for crash recovery.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const restore = useCallback(async (): Promise<boolean> => {
    if (!candidate || busy) return false;
    setBusy(true);
    setError(null);
    if (!(await restoreRecoverySnapshot(candidate))) {
      setError('The project could not be restored safely; the original snapshot was kept.');
      setBusy(false);
      return false;
    }
    setCandidate(null);
    setBusy(false);
    return true;
  }, [busy, candidate]);

  const discard = useCallback(async (): Promise<boolean> => {
    if (!candidate || busy) return false;
    setBusy(true);
    setError(null);
    if (!(await clearRecoverySnapshot(candidate.recoveryId))) {
      setError('The recovery file could not be removed.');
      setBusy(false);
      return false;
    }
    setCandidate(null);
    setBusy(false);
    return true;
  }, [busy, candidate]);

  return { candidate, busy, error, restore, discard };
}
