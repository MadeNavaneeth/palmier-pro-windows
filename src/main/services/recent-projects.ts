/**
 * Recent project paths, and the launch sweep that exists because of them.
 *
 * WHAT IS RECORDED, AND WHY IT IS A RECORD: the absolute path of every .vproj
 * this app opens or saves, most-recent-first. That is a record of where a
 * person keeps their work, so it is deliberately narrow. It lives only in this
 * app's own data directory as its own electron-store file — never inside a
 * .vproj, so it cannot travel with a project, be shared, or be uploaded by
 * anything that handles one. Nothing reads it except the code in this file: the
 * recent-projects endpoint returns it, and the launch sweep prunes staging
 * residue in the folders those paths name. To clear it, delete this app's
 * `recent-projects.json` from its user-data directory.
 *
 * WHY THE LIST IS THE POINT: a hard kill between the writer's `fs.open` and
 * `fs.rename` leaves a full-size staging file beside the user's project, and no
 * code of ours ever runs again to notice. The save handler already prunes the
 * residue in the one directory it is about, but that only helps the *next* save
 * into that same folder, and a crash means the next save may be never. The
 * recovery pipeline cannot help either: it only ever visits its own directory.
 * So the residue is swept at launch instead, over the folders this app knows
 * the user works in — which is only knowable from this list, and the endpoint
 * that should have returned it returned `[]`.
 *
 * The sweep reuses `pruneAbandonedWriteTemps` rather than growing a second
 * sweeper, so it inherits that function's bounding exactly: one directory per
 * entry, the writer's own staging-name convention, the process-start age gate,
 * no recursion, every failure swallowed.
 */

import path from 'path';
import { app } from 'electron';
import Store from 'electron-store';
import { pruneAbandonedWriteTemps } from './project-writer';

const SETTINGS_KEY = 'recentProjects';
/**
 * Same bound `export-history.ts` applies to its own list. It is also the sweep's
 * bound: the launch pass does at most one `readdir` per distinct directory
 * among these entries, and twenty recent projects is well past what the residue
 * problem needs — residue accumulates in the folders a user works in, not in
 * every folder they have ever worked in.
 */
const MAX_ENTRIES = 20;
/** Same bound `project.ts` applies to a session path, and `autosave.ts` to a snapshot. */
const MAX_PATH_LENGTH = 4096;
const VPROJ_EXTENSION = '.vproj';

let store: Store | null = null;

function getStore(): Store | null {
  if (!app) return null;
  store ??= new Store({ name: 'palmier-recent-projects' });
  return store;
}

/**
 * A recorded path is an absolute .vproj of a sane length.
 *
 * Checked on read as well as on write, because this list is the input to a
 * sweep: a hand-edited, truncated, or older-format store must not be able to
 * name a directory for `pruneAbandonedWriteTemps` to walk. The sweep is bounded
 * enough that the worst case is a wasted `readdir`, but the cheapest defence is
 * to refuse the entry.
 */
function isProjectPath(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_PATH_LENGTH
    && !value.includes('\0')
    && path.isAbsolute(value)
    && value.toLowerCase().endsWith(VPROJ_EXTENSION);
}

/**
 * Dedupe key. Windows paths are case-insensitive, so `C:\Cut.vproj` and
 * `c:\cut.vproj` are one file and must not take two slots or two sweeps.
 */
function dedupeKey(filePath: string): string {
  return path.normalize(filePath).toLowerCase();
}

/** Recent project paths, newest first. Never throws; an unusable store reads empty. */
export function loadRecentProjects(): string[] {
  let raw: unknown;
  try {
    raw = getStore()?.get(SETTINGS_KEY);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];

  // Re-validate, re-dedupe and re-bound on the way out rather than trusting
  // what is on disk, so a corrupt store degrades to a shorter list instead of
  // propagating entries the writer would never have written.
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!isProjectPath(entry)) continue;
    const key = dedupeKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
    if (out.length === MAX_ENTRIES) break;
  }
  return out;
}

/**
 * Record a project this app has just opened or saved, newest first.
 *
 * Called from the file-I/O handlers rather than from anything the renderer
 * reports, so the list reflects files that were genuinely read or written
 * instead of a path a window claimed to be holding. Re-recording a project
 * moves it to the front rather than adding a second entry for the same file.
 */
export function recordRecentProject(filePath: string): void {
  if (!isProjectPath(filePath)) return;
  try {
    const key = dedupeKey(filePath);
    const kept = loadRecentProjects().filter((entry) => dedupeKey(entry) !== key);
    getStore()?.set(SETTINGS_KEY, [filePath, ...kept].slice(0, MAX_ENTRIES));
  } catch {
    // An unwritable store must not turn a successful open or save into a
    // failure. The next open or save records again.
  }
}

/**
 * Prune crash residue in the folders the recent projects live in.
 *
 * One `pruneAbandonedWriteTemps` call per *distinct* directory, so twenty
 * projects in one folder cost one `readdir`, and each directory is swept
 * exactly once however many entries name it. Sequential and not parallel on
 * purpose: this is background work at launch, and a burst of concurrent
 * `readdir` across a user's project folders is not worth the saved wall-clock.
 * Never throws — `pruneAbandonedWriteTemps` swallows its own failures, and an
 * empty list simply sweeps nothing.
 */
export async function sweepRecentProjectResidue(): Promise<void> {
  const dirs = new Set<string>();
  for (const filePath of loadRecentProjects()) dirs.add(path.dirname(filePath));
  for (const dir of dirs) await pruneAbandonedWriteTemps(dir);
}
