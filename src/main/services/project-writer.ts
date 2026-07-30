/**
 * Project write coordinator.
 *
 * Windows translation of upstream Palmier Pro's project-package write contract
 * (PR #337 "serialized project-package writes", PR #403 "unblock the main
 * thread when a project write throws", PR #422 "unblock safe saves without
 * racing snapshots").
 *
 * Upstream's NSDocument save path keeps one save active and queues the rest,
 * because `write()` consumes a single shared snapshot at a time; two overlapping
 * saves would race that snapshot and either hang the main thread or persist a
 * mixed state. Electron has no NSDocument, but the same two hazards exist here:
 *
 *   1. Two writers aimed at one file. `project:save` and `project:autosave` are
 *      independent IPC calls; nothing stopped them from interleaving on the same
 *      target, and both previously derived their temp file name from the pid
 *      alone, so concurrent writes collided on one temp path.
 *   2. A failed write taking the file with it. A plain `writeFile` truncates the
 *      destination first, so a mid-write failure destroys the last good project.
 *
 * The contract implemented here:
 *
 *   - Writes to the same destination are serialized first-in-first-out.
 *   - Writes to different destinations stay independent.
 *   - One failure never stalls the queue and never blocks later writes.
 *   - Every write is atomic: a uniquely named temp file is written and flushed,
 *     then renamed over the destination. A crash or failure leaves the previous
 *     file intact and leaves no temp residue behind.
 *   - Nothing here touches Electron, so the contract is unit-testable and the
 *     renderer interaction path is never blocked on file I/O.
 */

import fs from 'fs/promises';
import path from 'path';
import { randomBytes } from 'crypto';

/** Tail of the write chain per destination. These promises never reject. */
const writeTails = new Map<string, Promise<void>>();
/** Outstanding write count per destination, used to release idle queues. */
const pendingWrites = new Map<string, number>();

let tempCounter = 0;

/**
 * Queue identity for a destination. Windows paths are case-insensitive, so
 * `C:\Projects\Cut.vproj` and `c:\projects\cut.vproj` must share one queue or
 * they would race each other.
 */
function writeKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Unique temp path beside the destination. Same directory so the rename stays
 * on one volume (a cross-volume rename is a copy, which is not atomic), and
 * unique per call so concurrent writers — including a second app instance —
 * cannot overwrite each other's staging file.
 */
function tempPathFor(filePath: string): string {
  tempCounter = (tempCounter + 1) % Number.MAX_SAFE_INTEGER;
  const suffix = `${process.pid}.${tempCounter}.${randomBytes(4).toString('hex')}`;
  return path.join(path.dirname(filePath), `.${path.basename(filePath)}.${suffix}.tmp`);
}

/**
 * Write `contents` to `filePath` atomically.
 *
 * The temp file is flushed to disk before the rename, so a power loss after the
 * rename cannot surface a file whose data never landed. On any failure the temp
 * file is removed and the destination keeps its previous contents.
 */
export async function atomicWriteFile(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = tempPathFor(filePath);

  try {
    const handle = await fs.open(tempPath, 'w');
    try {
      await handle.writeFile(contents, 'utf-8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Rename replaces the destination in one step; readers see either the old
    // file or the new one, never a partial write.
    await fs.rename(tempPath, filePath);
  } catch (err) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * Run `task` after every write already queued for `filePath` has settled.
 *
 * The returned promise reports only this task's outcome. A rejection is
 * contained: the queue advances to the next task regardless, so one failed save
 * cannot wedge autosave (or the reverse).
 */
export function enqueueWrite<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  const key = writeKey(filePath);
  const previous = writeTails.get(key) ?? Promise.resolve();

  const result = previous.then(task);
  // The stored tail must never reject, otherwise the next `.then(task)` would
  // skip its task and the queue would stop draining.
  const tail = result.then(
    () => undefined,
    () => undefined,
  );

  writeTails.set(key, tail);
  pendingWrites.set(key, (pendingWrites.get(key) ?? 0) + 1);

  void tail.then(() => {
    const remaining = (pendingWrites.get(key) ?? 1) - 1;
    if (remaining > 0) {
      pendingWrites.set(key, remaining);
      return;
    }
    pendingWrites.delete(key);
    // Only drop the tail if no newer write claimed the queue in the meantime.
    if (writeTails.get(key) === tail) writeTails.delete(key);
  });

  return result;
}

/**
 * Serialized atomic write — the single entry point for persisting project data.
 */
export function writeProjectFile(filePath: string, contents: string): Promise<void> {
  return enqueueWrite(filePath, () => atomicWriteFile(filePath, contents));
}

/** Number of writes queued or running for `filePath` (all destinations if omitted). */
export function pendingWriteCount(filePath?: string): number {
  if (filePath !== undefined) return pendingWrites.get(writeKey(filePath)) ?? 0;
  let total = 0;
  for (const count of pendingWrites.values()) total += count;
  return total;
}

/** Resolve once every queued write has settled. Used by shutdown and by tests. */
export async function drainWrites(): Promise<void> {
  while (writeTails.size > 0) {
    await Promise.all([...writeTails.values()]);
  }
}
