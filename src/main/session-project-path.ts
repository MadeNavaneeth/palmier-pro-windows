/**
 * Which .vproj a session holds, and whether its windows have been told.
 *
 * The renderer keeps the path in its project store, where every transition to a
 * new one lands (open, Save As, New, a recovery restore), and three of those
 * four are invisible to main: `createNew` writes no file and reaches no
 * main-owned channel, and a restore is a pure renderer-side load. So main's own
 * file operations record the path they used, the renderer reports its store's,
 * and the agent's document switches record theirs — each from whichever side
 * actually made the switch, and all of them into the one record below. That
 * record is what a reloaded window pulls alongside the project: without it the
 * window comes back to the right work and a Save that opens Save As over it.
 *
 * It lives here rather than in `ipc/project.ts` because it is no longer only
 * the project handlers' fact. The AI tool layer has to record into it too
 * (`ToolExecutor` holds a controller, and `sessionForController` is what turns
 * that into a session), and `main/ai/*` does not import `main/ipc/*` — so the
 * owner sits beside the session registry it is keyed by, and the project
 * handlers are one importer among three rather than the only way in.
 */

import { getSessionForSender, type Session, type SessionSender } from './sessions';

/** Same bound autosave.ts applies to the path in a recovery snapshot. */
const MAX_SESSION_PATH_LENGTH = 4096;

/**
 * What a session holds, keyed by the session itself.
 *
 * A WeakMap rather than a field on the session, and that is the whole point:
 * "the window closed" clears the record by construction, because a removed
 * session is unreachable and the next session starts with no path. Nothing has
 * to remember to forget it on a teardown path that may not run, and no session
 * can ever read another's path. A plain map would keep a closed window's path
 * alive and would have to be pruned in step with the session registry.
 *
 * `announced` is what makes a push's path a change rather than a constant: a
 * write clears it, and a window applying the push clears it again. It is
 * consumed by APPLICATION, never by the push that carries it: a window
 * refuses an inbound push whenever a local write is still outstanding, and
 * clearing on send spent the announcement on a message that window never
 * read. Nothing re-armed it, so the record claimed a window had been told a
 * path it did not have, and a reloaded window came back holding one project's
 * state and another project's path.
 *
 * A session with no record has nothing to announce, which is the right answer
 * for a window that has only just mounted — it pulls the record — and for one
 * that was told of the last write. Deriving it by comparing pushes instead
 * would hand a window back the path it had just chosen and reported, whenever
 * main had not caught up to the report yet.
 */
interface SessionProjectPath {
  filePath: string | null;
  announced: boolean;
}

const sessionProjectPaths = new WeakMap<Session, SessionProjectPath>();

/** The .vproj this session holds, or null when it holds none. */
export function sessionProjectPathOf(session: Session): string | null {
  return sessionProjectPaths.get(session)?.filePath ?? null;
}

/** A reported or chosen path is a plain path string or nothing at all. */
export function isSessionFilePath(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_SESSION_PATH_LENGTH
    && !value.includes('\0');
}

/**
 * Record the file this session holds, or clear it with null.
 *
 * The one write every side of the boundary shares, so a reported path, a
 * chosen one and one the agent opened cannot end up validated differently. A
 * value that is not a path leaves the record untouched: the project handler has
 * already refused one at its channel with a reason, and a tool call that read
 * its path off disk has nothing left to refuse.
 */
export function recordSessionProjectPath(session: Session, filePath: string | null): void {
  if (filePath !== null && !isSessionFilePath(filePath)) return;
  sessionProjectPaths.set(session, { filePath, announced: false });
}

/**
 * The path this session's windows have not been told yet, or undefined when
 * there is none to tell them.
 *
 * A peek, not a take: the value stays pending until a window reports the path it
 * now holds, which is the only evidence any window applied it. A session with no
 * windows to tell therefore leaves it pending for whichever window joins next
 * rather than dropping it on the floor, and a window that refuses this push
 * leaves it for the next one to carry.
 */
export function takeSessionProjectPathAnnouncement(session: Session): string | null | undefined {
  const record = sessionProjectPaths.get(session);
  if (!record || record.announced) return undefined;
  return record.filePath;
}

/**
 * A window reported the path it now holds, so a pending announcement is spent.
 *
 * The consuming half of the record, and deliberately NOT `recordSessionProjectPath`:
 * that ARMS, so routing a report through it would re-arm on every adoption and
 * carry the path forever instead of once. This clears the flag, and only when the
 * reported value is the one pending. A window reporting some OTHER path is
 * asserting a change of its own, which is a write, not a confirmation.
 *
 * A matching report is a CONFIRMATION rather than a write, which is what makes
 * the push that carried the path the last one to carry it: the window reports
 * because applying that push is what it did, so the report and the adoption are
 * the same event seen from two sides. A window that already held the path
 * reports it too, which is what keeps a session that is only ever pushed to
 * from re-announcing on every push.
 */
export function consumeSessionProjectPathAnnouncement(
  session: Session,
  filePath: string | null,
): void {
  const record = sessionProjectPaths.get(session);
  // No record, or a different path, is the window asserting a change of its
  // own rather than confirming one: a write, which arms. A report is also how
  // a first document reaches the record at all, since `createNew` and a
  // recovery restore reach no main-owned file handler.
  if (!record || record.filePath !== filePath) {
    recordSessionProjectPath(session, filePath);
    return;
  }
  // The same path, so the window holds what was pending, and the announcement is
  // spent. A detached panel shares the session but not the store and never
  // reports, so this must not wait for one — it would wait forever, and the path
  // would ride every later push for the life of the session. A panel that has
  // not been told pulls the record when it mounts, which is how it learns the
  // path in the first place.
  record.announced = true;
}

/**
 * Record the path for the sender's session, if it has one.
 *
 * The file operation itself never depends on a session — it has already
 * happened by the time this is called — so a sender that resolves to nothing
 * simply leaves the record alone rather than failing the write.
 */
export function rememberSessionPath(sender: SessionSender | null | undefined, filePath: string): void {
  const session = getSessionForSender(sender);
  if (session) recordSessionProjectPath(session, filePath);
}
