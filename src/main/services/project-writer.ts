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
 *     then renamed over the destination. A failure leaves the previous file
 *     intact and removes the staging file; a hard kill leaves the previous file
 *     intact and the staging file behind, which `pruneAbandonedWriteTemps`
 *     reclaims on the next write into that directory.
 *   - Nothing here touches Electron, so the contract is unit-testable and the
 *     renderer interaction path is never blocked on file I/O.
 *
 * Upstream analogue: none for the residue sweep. NSDocument's write-to-temporary-
 * file-then-replace is one API call inside the framework, so a process cannot be
 * killed between the two halves and no residue is ever created for it to reap.
 * Splitting the atomic write into two Node calls — which is what makes this
 * implementation atomic at all — is what creates the window the sweep closes.
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
 * Wall-clock instant at which this process evaluated this module, used as the
 * process-start reference when pruning abandoned staging files.
 *
 * Node exposes no portable process start time. `os.uptime()` is *system*
 * uptime on Windows and POSIX alike, so a start time derived from it is boot
 * time, and every staging file would look abandoned. Module evaluation is the
 * best available signal and it errs late: a file created between the real
 * process start and this line counts as recent, so this reference can only ever
 * leave residue for a later launch instead of deleting a live write.
 */
export const PROCESS_START_MS = Date.now();

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
 * The staging names `tempPathFor` produces, read from the right:
 * `.<basename>.<pid>.<counter>.<8 lowercase hex digits>.tmp`.
 *
 * The recognizer sits beside the producer so the two cannot drift apart. Only
 * the four trailing segments are constrained: `basename` is `path.basename` of
 * the destination and may itself contain dots, so a recovery snapshot stages as
 * `.<sessionId>.json.<pid>.<n>.<hex>.tmp`. Everything else is anchored — the
 * leading dot, the literal `.tmp` suffix, two decimal numbers, and exactly eight
 * lowercase hex digits, because `randomBytes(4).toString('hex')` emits nothing
 * else. Callers pass a directory-entry name, so a match can only ever name a
 * file inside the directory they listed.
 */
const ATOMIC_TEMP_NAME_RE = /^\.(.+)\.\d+\.\d+\.[0-9a-f]{8}\.tmp$/;

/** Whether `fileName` is a staging name this writer would have produced. */
export function isAtomicWriteTempName(fileName: string): boolean {
  return ATOMIC_TEMP_NAME_RE.test(fileName);
}

/**
 * Remove one atomic-write staging file abandoned by an earlier process.
 *
 * Age is the only safe test, and it is a complete one. A staging name is unique
 * per write and never reused, so a file whose mtime predates this process can
 * never become an in-flight write again, while a staging file a live write in
 * this process is using was necessarily created after this process started.
 * Deleting an abandoned file therefore cannot disturb a write that still needs
 * it; deleting a *recent* one would, which is why the age test is not a cleanup
 * heuristic that may be relaxed.
 *
 * The reasoning, the gate and the `PROCESS_START_MS` reference are the same ones
 * `inspectRecoveryDirectory` applies to the recovery directory; the recovery
 * copy is private to that module, so the two live side by side and both call
 * the recognizer above rather than restating the shape.
 */
async function removeAbandonedWriteTemp(filePath: string): Promise<void> {
  try {
    // lstat, as in the recovery sweep: a symlink planted under a staging name
    // is not writer residue, so it is left alone.
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.mtimeMs >= PROCESS_START_MS) return;
    await fs.rm(filePath, { force: true });
  } catch {
    // Best effort, as in the recovery sweep: a vanished or unreadable entry
    // must not make a save fail, and the next save can try again.
  }
}

/**
 * Prune the atomic-write staging files abandoned in `dir` by an earlier process.
 *
 * Bounded on purpose. `dir` is the one directory a caller passed in — the
 * folder holding a project the user just saved — so this is a sweep of our own
 * residue beside a known target, not a general-purpose cleaner: one directory,
 * one name convention, one age gate, no recursion.
 *
 * `atomicWriteFile` only removes its own staging file when it is still running
 * and can reach its `catch`. A hard kill between `fs.open` and `fs.rename`
 * leaves a full-size staging file in the user's project folder, and no code of
 * ours ever runs again to notice, so without a sweep the residue is
 * permanent. This is the same failure the recovery directory had, and it is
 * the same fix; the recovery pipeline cannot reach here because it only ever
 * visits its own directory.
 *
 * Best effort throughout: every failure is swallowed so pruning can never turn
 * a successful save into a failed one.
 */
export async function pruneAbandonedWriteTemps(dir: string): Promise<void> {
  let entries: string[];
  try {
    // Nothing here prunes anything that is not a plain file inside `dir` (see
    // removeAbandonedWriteTemp), so refusing a non-directory target up front
    // keeps the sweep to the one directory the caller named.
    const dirStat = await fs.lstat(dir);
    if (!dirStat.isDirectory()) return;
    entries = await fs.readdir(dir);
  } catch {
    return;
  }

  for (const name of entries) {
    if (isAtomicWriteTempName(name)) await removeAbandonedWriteTemp(path.join(dir, name));
  }
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
