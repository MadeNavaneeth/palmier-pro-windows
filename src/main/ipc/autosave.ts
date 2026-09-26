/**
 * Autosave + crash recovery, per session (#137 Slice 1).
 *
 * The renderer debounces edits and pushes a snapshot here. Each main window
 * writes its own atomic recovery file, so two live sessions never clobber one
 * another. On startup the renderer asks this module to discover an orphaned
 * file: the current session UUID is not useful after a process restart, but
 * the file name still is a safe, enumerable identity.
 *
 * A recovery check is deliberately conservative. Only regular files with a
 * charset-guarded session name are considered, snapshots are schema-checked
 * before they cross the IPC boundary, and files belonging to any live session
 * in this process are neither offered nor pruned. The newest valid orphan is
 * returned for one explicit Restore/Discard decision. A bounded number of
 * other valid orphans is retained for later launches; invalid, stale, and
 * overflow files are removed.
 *
 * The atomic + serialized write contract itself lives in
 * `main/services/project-writer.ts`, shared with explicit project saves.
 */

import { ipcMain, app } from 'electron';
import path from 'path';
import fs from 'fs/promises';
import { writeProjectFile } from '../services/project-writer';
import {
  NO_SESSION_ERROR,
  getSessionForSender,
  listSessions,
} from '../sessions';

export interface RecoverySnapshot {
  savedAt: string; // ISO timestamp
  projectFilePath: string | null; // the .vproj this snapshot belongs to (if any)
  projectName: string;
  data: string; // serialized project JSON
}

export interface RecoveryCandidate {
  /** The session id encoded in the recovery filename. */
  recoveryId: string;
  snapshot: RecoverySnapshot;
}

export interface RecoveryDiscovery {
  /** Newest valid orphan, or null when there is nothing to offer. */
  candidate: RecoveryCandidate | null;
  /** Valid orphans retained after the bounded pruning pass. */
  retained: RecoveryCandidate[];
}

/** Keep enough distinct crashes recoverable without allowing unbounded growth. */
export const MAX_ORPHAN_RECOVERY_FILES = 10;

/** Recovery documents are project metadata, not media payloads. */
const MAX_RECOVERY_FILE_BYTES = 128 * 1024 * 1024;
const MAX_RECOVERY_NAME_LENGTH = 512;
const MAX_RECOVERY_PATH_LENGTH = 4096;
const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;
const RECOVERY_FILE_RE = /^([A-Za-z0-9_-]+)\.json$/;

// Clear and autosave must be ordered per session. Without this small queue,
// a clean-save clear can finish after a later autosave request and delete the
// newer snapshot. It also keeps a clear from racing the writer that precedes
// it, while allowing different sessions to proceed independently.
const recoveryOperations = new Map<string, Promise<void>>();

function recoveryIdKey(recoveryId: string): string {
  // Windows paths are case-insensitive, so an uppercase spelling of a live
  // UUID must not bypass the protection or create a second operation queue.
  return process.platform === 'win32' ? recoveryId.toLowerCase() : recoveryId;
}

function enqueueRecoveryOperation<T>(
  recoveryId: string,
  task: () => Promise<T>,
): Promise<T> {
  const key = recoveryIdKey(recoveryId);
  const previous = recoveryOperations.get(key) ?? Promise.resolve();
  const result = previous.then(task);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  recoveryOperations.set(key, tail);
  void tail.then(() => {
    if (recoveryOperations.get(key) === tail) recoveryOperations.delete(key);
  });
  return result;
}

function recoveryDir(): string {
  return path.join(app.getPath('userData'), 'recovery');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Basic project-shape check used before a user-writable recovery document is
 * returned to the renderer. Full migrations and domain narrowing still happen
 * through EditorController.deserialize in the recovery hook.
 */
function isProjectDocument(value: unknown): boolean {
  if (!isRecord(value) || typeof value.name !== 'string') return false;
  const timeline = value.timeline;
  return isRecord(value.settings)
    && Array.isArray(value.media)
    && isRecord(timeline)
    && Array.isArray(timeline.tracks)
    && Array.isArray(timeline.clips);
}

/** Whether a string is safe to use as a recovery filename identity. */
export function isRecoverySessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_RE.test(value);
}

/**
 * Pure path rule: one recovery file per session id.
 *
 * The id is minted in this process (crypto.randomUUID), never taken from the
 * renderer — the charset is still narrowed so even a hand-corrupted id can
 * never steer the path out of the recovery directory.
 */
export function recoveryFileForSession(dir: string, sessionId: string): string {
  if (!isRecoverySessionId(sessionId)) {
    throw new Error('Invalid session id for recovery path.');
  }
  return path.join(dir, `${sessionId}.json`);
}

/**
 * Extract a session id from a directory entry. Invalid names are ignored by
 * discovery rather than being turned into paths.
 */
export function recoverySessionIdFromFileName(fileName: string): string | null {
  const match = RECOVERY_FILE_RE.exec(fileName);
  return match?.[1] ?? null;
}

/** Parse and narrow one recovery document. Invalid JSON is never fatal. */
export function parseRecoverySnapshot(raw: string): RecoverySnapshot | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(value)) return null;
  if (typeof value.savedAt !== 'string' || !Number.isFinite(Date.parse(value.savedAt))) {
    return null;
  }
  if (
    typeof value.projectName !== 'string'
    || value.projectName.length > MAX_RECOVERY_NAME_LENGTH
  ) {
    return null;
  }
  if (
    value.projectFilePath !== null
    && (
      typeof value.projectFilePath !== 'string'
      || value.projectFilePath.length > MAX_RECOVERY_PATH_LENGTH
      || value.projectFilePath.includes('\0')
    )
  ) {
    return null;
  }
  if (typeof value.data !== 'string' || value.data.length > MAX_RECOVERY_FILE_BYTES) {
    return null;
  }

  let project: unknown;
  try {
    project = JSON.parse(value.data);
  } catch {
    return null;
  }
  if (!isProjectDocument(project)) return null;

  return {
    savedAt: value.savedAt,
    projectFilePath: value.projectFilePath as string | null,
    projectName: value.projectName,
    data: value.data,
  };
}

/** Newest first, with a stable id tie-breaker for deterministic tests/UI. */
function compareCandidates(left: RecoveryCandidate, right: RecoveryCandidate): number {
  const timeDelta = Date.parse(right.snapshot.savedAt) - Date.parse(left.snapshot.savedAt);
  if (timeDelta !== 0) return timeDelta;
  return left.recoveryId.localeCompare(right.recoveryId);
}

/**
 * A snapshot is useful when it is newer than the real project file it names.
 * A missing/deleted/non-file path is treated as an unsaved project: the
 * recovery is more valuable than silently discarding it.
 */
async function isNewerThanLastSave(snapshot: RecoverySnapshot): Promise<boolean> {
  if (snapshot.projectFilePath === null) return true;
  try {
    const stat = await fs.stat(snapshot.projectFilePath);
    if (!stat.isFile()) return true;
    return Date.parse(snapshot.savedAt) > stat.mtimeMs;
  } catch {
    return true;
  }
}

async function readSnapshotFile(
  dir: string,
  recoveryId: string,
): Promise<RecoverySnapshot | null> {
  const filePath = recoveryFileForSession(dir, recoveryId);
  try {
    // lstat rejects symlinks and other user-created indirections. The name
    // charset plus this check keeps discovery inside the recovery directory.
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.size > MAX_RECOVERY_FILE_BYTES) return null;
    return parseRecoverySnapshot(await fs.readFile(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

async function removeIfStillOrphan(
  filePath: string,
  recoveryId: string,
  isSessionLive: (recoveryId: string) => boolean,
): Promise<void> {
  // Re-check immediately before removal: a session may have been created
  // while the directory was being read.
  if (isSessionLive(recoveryId)) return;
  try {
    await fs.rm(filePath, { force: true });
  } catch {
    // Pruning is best effort; an unreadable/hostile file must not make launch
    // fail, and a later check can try again.
  }
}

/**
 * Enumerate, validate, and prune recovery files.
 *
 * `isSessionLive` is injectable so the handler can re-check the live registry
 * immediately before every delete. The default is useful for pure callers and
 * tests that pass a fixed set of active ids.
 */
export async function inspectRecoveryDirectory(
  dir: string,
  activeSessionIds: Iterable<string>,
  isSessionLive: (recoveryId: string) => boolean = (() => false),
): Promise<RecoveryDiscovery> {
  const initialActive = new Set(
    [...activeSessionIds].map((recoveryId) => recoveryIdKey(recoveryId)),
  );
  let entries: Array<{ name: string; isFile: () => boolean }>;
  try {
    // lstat prevents a user-created junction/symlink at `recovery` itself from
    // redirecting the scan outside userData.
    const dirStat = await fs.lstat(dir);
    if (!dirStat.isDirectory()) return { candidate: null, retained: [] };
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    // A first launch has no recovery directory yet.
    return { candidate: null, retained: [] };
  }

  const candidates: RecoveryCandidate[] = [];
  for (const entry of entries) {
    const recoveryId = recoverySessionIdFromFileName(entry.name);
    if (
      recoveryId === null
      || !entry.isFile()
      || initialActive.has(recoveryIdKey(recoveryId))
      || isSessionLive(recoveryId)
    ) {
      continue;
    }

    const snapshot = await readSnapshotFile(dir, recoveryId);
    if (snapshot === null || !(await isNewerThanLastSave(snapshot))) {
      await removeIfStillOrphan(
        recoveryFileForSession(dir, recoveryId),
        recoveryId,
        isSessionLive,
      );
      continue;
    }

    // A new window can have claimed this id while the file was being read.
    if (isSessionLive(recoveryId)) continue;
    candidates.push({ recoveryId, snapshot });
  }

  candidates.sort(compareCandidates);
  const retained = candidates.slice(0, MAX_ORPHAN_RECOVERY_FILES);
  const overflow = candidates.slice(MAX_ORPHAN_RECOVERY_FILES);
  await Promise.all(
    overflow.map((candidate) => removeIfStillOrphan(
      recoveryFileForSession(dir, candidate.recoveryId),
      candidate.recoveryId,
      isSessionLive,
    )),
  );

  // A session created during the pass can protect a retained file after the
  // initial scan. Filter once more before exposing anything to the renderer.
  const liveRetained = retained.filter((candidate) => !isSessionLive(candidate.recoveryId));
  return {
    candidate: liveRetained[0] ?? null,
    retained: liveRetained,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasLiveSession(recoveryId: string): boolean {
  const key = recoveryIdKey(recoveryId);
  return listSessions().some((session) => recoveryIdKey(session.id) === key);
}

export function registerAutosaveHandlers(): void {
  // Renderer pushes a debounced snapshot of the current project.
  ipcMain.handle(
    'project:autosave',
    async (event, projectName: unknown, projectFilePath: unknown, data: unknown) => {
      const session = getSessionForSender(event.sender);
      if (!session) return { success: false, error: NO_SESSION_ERROR };
      if (
        typeof projectName !== 'string'
        || projectName.length > MAX_RECOVERY_NAME_LENGTH
        || (
          projectFilePath !== null
          && (
            typeof projectFilePath !== 'string'
            || projectFilePath.length > MAX_RECOVERY_PATH_LENGTH
            || projectFilePath.includes('\0')
          )
        )
        || typeof data !== 'string'
        || data.length > MAX_RECOVERY_FILE_BYTES
      ) {
        return { success: false, error: 'Invalid crash-recovery snapshot payload.' };
      }
      try {
        // Do not persist a malformed document just because it arrived through
        // the renderer bridge. The same shape check is repeated on recovery
        // read because the recovery directory is user-writable.
        if (!isProjectDocument(JSON.parse(data))) {
          return { success: false, error: 'Invalid crash-recovery project data.' };
        }
        const snapshot: RecoverySnapshot = {
          savedAt: new Date().toISOString(),
          projectFilePath: projectFilePath as string | null,
          projectName,
          data,
        };
        // Serialized through the shared write coordinator: a debounced
        // autosave burst can no longer collide with itself on one temp file,
        // and each snapshot lands whole (upstream #337 / #422).
        const filePath = recoveryFileForSession(recoveryDir(), session.id);
        await enqueueRecoveryOperation(
          session.id,
          () => writeProjectFile(filePath, JSON.stringify(snapshot)),
        );
        return { success: true, savedAt: snapshot.savedAt };
      } catch (err: unknown) {
        return { success: false, error: errorMessage(err) };
      }
    },
  );

  // On startup the renderer asks for one orphaned snapshot. The sender must
  // still belong to a live session, but the candidate may belong to a session
  // that existed in an earlier process.
  ipcMain.handle('project:recovery-check', async (event) => {
    if (!getSessionForSender(event.sender)) return { hasRecovery: false };
    try {
      const discovery = await inspectRecoveryDirectory(
        recoveryDir(),
        listSessions().map((session) => session.id),
        hasLiveSession,
      );
      const candidate = discovery.candidate;
      if (!candidate) return { hasRecovery: false };
      return {
        hasRecovery: true,
        recoveryId: candidate.recoveryId,
        snapshot: candidate.snapshot,
      };
    } catch {
      return { hasRecovery: false };
    }
  });

  // Clear the current file after a clean save, or a specifically named orphan
  // after the user restores/discards it. A renderer can never clear a live
  // session's file through the explicit-id form.
  ipcMain.handle('project:recovery-clear', async (event, recoveryId?: unknown) => {
    const session = getSessionForSender(event.sender);
    if (!session) return { success: false, error: NO_SESSION_ERROR };
    if (recoveryId !== undefined && !isRecoverySessionId(recoveryId)) {
      return { success: false, error: 'Invalid recovery id.' };
    }
    const targetId = recoveryId ?? session.id;
    const ownFile = recoveryIdKey(targetId) === recoveryIdKey(session.id);
    if (!ownFile && hasLiveSession(targetId)) {
      return { success: false, error: 'That recovery belongs to a live session.' };
    }
    try {
      const filePath = recoveryFileForSession(recoveryDir(), targetId);
      const cleared = await enqueueRecoveryOperation(targetId, async () => {
        // The session may have been created while this clear waited behind an
        // earlier autosave. Never remove a file that became live in the
        // meantime.
        if (!ownFile && hasLiveSession(targetId)) return false;
        await fs.rm(filePath, { force: true });
        return true;
      });
      if (!cleared) {
        return { success: false, error: 'That recovery belongs to a live session.' };
      }
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: errorMessage(err) };
    }
  });
}
