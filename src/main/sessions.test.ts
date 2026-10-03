/**
 * Session registry coverage (upstream #137, Slice 1): mint, sender lookup,
 * remove-on-close, detached windows joining their parent session,
 * session-scoped broadcast, and the reverse lookup from a controller to the
 * session that minted it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EditorController } from '../shared/editor/controller';
import {
  addWindow,
  broadcastToSession,
  createSession,
  getActiveSession,
  getSession,
  getSessionForSender,
  listSessions,
  markSessionActive,
  removeSession,
  removeWindow,
  resetSessions,
  sessionForController,
  type SessionWindow,
} from './sessions';

function fakeWindow(
  id: number,
): SessionWindow & { sent: Array<{ channel: string; payload: unknown }>; destroyed: boolean } {
  const win = {
    id,
    destroyed: false,
    sent: [] as Array<{ channel: string; payload: unknown }>,
    isDestroyed: () => win.destroyed,
    send: (channel: string, payload?: unknown) => {
      win.sent.push({ channel, payload });
    },
  };
  return win;
}

beforeEach(() => resetSessions());
afterEach(() => resetSessions());

describe('session registry (#137 Slice 1)', () => {
  it('mints a unique id and an independent controller per session', () => {
    const a = createSession();
    const b = createSession();

    expect(a.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(a.id).not.toBe(b.id);
    expect(a.controller).not.toBe(b.controller);

    // Editing one session's project leaves the other untouched.
    a.controller.adoptProject({ ...a.controller.getProject(), name: 'Only A' });
    expect(a.controller.getProject().name).toBe('Only A');
    expect(b.controller.getProject().name).not.toBe('Only A');
  });

  it('resolves a window’s session from the sender id', () => {
    const session = createSession();
    expect(addWindow(session.id, fakeWindow(1))).toBe(true);

    expect(getSession(session.id)).toBe(session);
    expect(getSessionForSender({ id: 1 })).toBe(session);
    expect(getSessionForSender({ id: 999 })).toBeNull();
    expect(getSessionForSender(null)).toBeNull();
    expect(getSessionForSender(undefined)).toBeNull();
  });

  it('lets a detached window join its parent session', () => {
    const parent = createSession();
    const other = createSession();
    addWindow(parent.id, fakeWindow(1)); // parent main window
    addWindow(parent.id, fakeWindow(2)); // panel detached from it
    addWindow(other.id, fakeWindow(3)); // another workspace

    // Both parent windows route to the parent; the other session stays separate.
    expect(getSessionForSender({ id: 1 })).toBe(parent);
    expect(getSessionForSender({ id: 2 })).toBe(parent);
    expect(getSessionForSender({ id: 3 })).toBe(other);
    expect(parent.windows.size).toBe(2);
    expect(listSessions()).toHaveLength(2);
    expect(listSessions().map((entry) => entry.id).sort()).toEqual(
      [parent.id, other.id].sort(),
    );
  });

  it('drops a closed window from the lookup without ending the session', () => {
    const session = createSession();
    addWindow(session.id, fakeWindow(1));
    addWindow(session.id, fakeWindow(2));

    removeWindow(1);

    expect(getSessionForSender({ id: 1 })).toBeNull();
    expect(getSessionForSender({ id: 2 })).toBe(session);
    expect(getSession(session.id)).toBe(session);
    expect(session.windows.size).toBe(1);
  });

  it('removes a session and every window lookup with it', () => {
    const session = createSession();
    addWindow(session.id, fakeWindow(1));
    addWindow(session.id, fakeWindow(2));

    removeSession(session.id);

    expect(getSession(session.id)).toBeNull();
    expect(getSessionForSender({ id: 1 })).toBeNull();
    expect(getSessionForSender({ id: 2 })).toBeNull();
    expect(listSessions()).toEqual([]);
  });

  it('refuses to attach a window to an unknown session', () => {
    expect(addWindow('missing-session', fakeWindow(1))).toBe(false);
    expect(getSessionForSender({ id: 1 })).toBeNull();
  });

  it('removeWindow for an unknown id is a no-op', () => {
    const session = createSession();
    addWindow(session.id, fakeWindow(1));

    removeWindow(42);

    expect(getSessionForSender({ id: 1 })).toBe(session);
    expect(getSession(session.id)).toBe(session);
  });
});

describe('active session (#137 Slice 2)', () => {
  it('marks the newest session active and follows markSessionActive', () => {
    const a = createSession();
    expect(getActiveSession()).toBe(a);
    const b = createSession();
    expect(getActiveSession()).toBe(b);

    markSessionActive(a.id);
    expect(getActiveSession()).toBe(a);

    // An unknown id never steals the designation.
    markSessionActive('gone');
    expect(getActiveSession()).toBe(a);
  });

  it('falls back to a remaining session when the active one is removed', () => {
    const a = createSession();
    const b = createSession(); // active
    removeSession(b.id);
    expect(getActiveSession()).toBe(a);

    removeSession(a.id);
    expect(getActiveSession()).toBeNull();
  });

  it('clears the designation on reset', () => {
    createSession();
    resetSessions();
    expect(getActiveSession()).toBeNull();
  });
});

describe('session-scoped broadcast (#137)', () => {
  it('reaches only the live windows of the named session', () => {
    const a = createSession();
    const b = createSession();
    const liveA = fakeWindow(1);
    const deadA = fakeWindow(2);
    deadA.destroyed = true;
    const liveB = fakeWindow(3);
    addWindow(a.id, liveA);
    addWindow(a.id, deadA);
    addWindow(b.id, liveB);

    broadcastToSession(a.id, 'editor:apply-from-main', '{"name":"A"}');

    expect(liveA.sent).toEqual([
      { channel: 'editor:apply-from-main', payload: '{"name":"A"}' },
    ]);
    expect(deadA.sent).toEqual([]);
    expect(liveB.sent).toEqual([]);
  });

  it('is a no-op for an unknown session', () => {
    expect(() => broadcastToSession('gone', 'editor:apply-from-main', 1)).not.toThrow();
  });
});

describe('a controller names its session', () => {
  it('resolves the session that minted it, and nothing else', () => {
    const a = createSession();
    const b = createSession();

    // What the AI layer holds is a controller, never a session id. One is
    // minted per session, so this is the whole identity a tool call needs to
    // record which .vproj the session behind it is working on.
    expect(sessionForController(a.controller)).toBe(a);
    expect(sessionForController(b.controller)).toBe(b);

    // A controller no session owns is every unit test's executor, and a
    // windowless run has no window to keep a document path for.
    expect(sessionForController(new EditorController())).toBeNull();
    expect(sessionForController(null)).toBeNull();

    // The lookup is a WeakMap, so a removed session's entry goes with the
    // controller it can no longer be reached through — and the live one is
    // untouched.
    removeSession(a.id);
    expect(sessionForController(b.controller)).toBe(b);
  });
});
