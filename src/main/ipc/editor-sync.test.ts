/**
 * Session-scoped editor sync coverage (upstream #137, Slice 1).
 *
 * `editor:apply-from-main` must reach the main window and detached panels of
 * the session that owns the edit — and nobody else. Renderer-originated edits
 * use a tagged second argument so siblings can replace their controller state
 * without adding a command to their undo history; a main-side (agent/MCP) push
 * carries the kind its controller published, so a window can tell the agent's
 * `set_playhead` (a view update) from the agent's real edits (one undoable
 * step) without guessing from the snapshot. An untagged push stays the
 * conservative undoable default.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attachSessionEditorPush,
  registerEditorSyncHandlers,
} from './editor-sync';
import {
  addWindow,
  createSession,
  getSessionForSender,
  NO_SESSION_ERROR,
  resetSessions,
  type SessionWindow,
} from '../sessions';
import type { EditorController } from '../../shared/editor/controller';

type MockIpcHandler = (
  event: { sender: { id: number } },
  ...args: unknown[]
) => unknown;

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, MockIpcHandler>(),
  fromWebContents: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, listener: MockIpcHandler) => {
      electronMocks.handlers.set(channel, listener);
    },
  },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  BrowserWindow: {
    fromWebContents: electronMocks.fromWebContents,
    getFocusedWindow: () => null,
  },
}));

const PUSH_DEBOUNCE_MS = 30;
/** Covers the push debounce plus scheduling slack (see editor-sync.ts). */
const PUSH_WAIT_MS = PUSH_DEBOUNCE_MS + 50;

function fakeWindow(
  id: number,
): SessionWindow & {
  sent: Array<{ channel: string; payload: unknown }>;
  calls: Array<{ channel: string; args: unknown[] }>;
  destroyed: boolean;
} {
  const win = {
    id,
    destroyed: false,
    sent: [] as Array<{ channel: string; payload: unknown }>,
    calls: [] as Array<{ channel: string; args: unknown[] }>,
    isDestroyed: () => win.destroyed,
    send: (channel: string, ...args: unknown[]) => {
      win.sent.push({ channel, payload: args[0] });
      win.calls.push({ channel, args });
    },
  };
  return win;
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, PUSH_WAIT_MS));
}

function syncFrom(windowId: number, project: unknown): Promise<unknown> {
  const handler = electronMocks.handlers.get('editor:sync-from-renderer');
  if (!handler) throw new Error('editor sync handler was not registered');
  return Promise.resolve(handler({ sender: { id: windowId } }, JSON.stringify(project)));
}

beforeAll(() => {
  registerEditorSyncHandlers();
});

beforeEach(() => {
  resetSessions();
  electronMocks.fromWebContents.mockReset();
  electronMocks.fromWebContents.mockReturnValue(null);
});
afterEach(() => resetSessions());

describe('attachSessionEditorPush (#137 Slice 1)', () => {
  it('sends a main-side edit only to the owning session’s windows', async () => {
    const a = createSession();
    const b = createSession();
    const mainA = fakeWindow(1);
    const panelA = fakeWindow(2);
    const mainB = fakeWindow(3);
    addWindow(a.id, mainA);
    addWindow(a.id, panelA);
    addWindow(b.id, mainB);
    attachSessionEditorPush(a);

    a.controller.adoptProject({ ...a.controller.getProject(), name: 'From A agent' });
    await settle();

    const expected = ['editor:apply-from-main'];
    expect(mainA.sent.map((message) => message.channel)).toEqual(expected);
    expect(panelA.sent.map((message) => message.channel)).toEqual(expected);
    expect(mainB.sent).toEqual([]);

    const [first] = mainA.sent;
    expect(JSON.parse(first.payload as string).name).toBe('From A agent');
    // The main-side push is the project plus a tag of its own shape, which
    // cannot be mistaken for the renderer tag that selects the silent branch.
    expect(mainA.calls[0].args[1]).toEqual({ source: 'main', kind: 'edit' });
  });

  it('tags a cursor move as a playhead, not an edit', async () => {
    const session = createSession();
    const main = fakeWindow(1);
    addWindow(session.id, main);
    attachSessionEditorPush(session);

    // What the agent's set_playhead does to the session's controller: the
    // cursor moves and no command is published, so no history entry either.
    session.controller.setPlayhead(120);
    await settle();

    expect(session.controller.canUndo()).toBe(false);
    expect(main.calls).toHaveLength(1);
    expect(main.calls[0].args[1]).toEqual({ source: 'main', kind: 'playhead' });
    expect(JSON.parse(main.calls[0].args[0] as string).timeline.playheadFrame).toBe(120);
  });

  it('collapses a cursor move and an edit into one edit-tagged push', async () => {
    // Both orders matter: the tag describes the collapsed window, not whichever
    // notification happened to arrive last, or a turn that ends on a cursor
    // move would be adopted as a view update and lose the edit.
    for (const order of ['playhead-first', 'edit-first'] as const) {
      resetSessions();
      const session = createSession();
      const main = fakeWindow(1);
      addWindow(session.id, main);
      attachSessionEditorPush(session);

      const parkCursor = (): void => session.controller.setPlayhead(90);
      const edit = (): void => session.controller.adoptProject(
        { ...session.controller.getProject(), name: 'Agent rename' },
      );
      if (order === 'playhead-first') {
        parkCursor();
        edit();
      } else {
        edit();
        parkCursor();
      }
      await settle();

      expect(main.calls).toHaveLength(1);
      expect(main.calls[0].args[1]).toEqual({ source: 'main', kind: 'edit' });
      const pushed = JSON.parse(main.calls[0].args[0] as string);
      expect(pushed.name).toBe('Agent rename');
      expect(pushed.timeline.playheadFrame).toBe(90);
    }
  });

  it('collapses a burst of edits into one push', async () => {
    const session = createSession();
    const main = fakeWindow(1);
    addWindow(session.id, main);
    attachSessionEditorPush(session);

    session.controller.adoptProject({ ...session.controller.getProject(), name: 'One' });
    session.controller.adoptProject({ ...session.controller.getProject(), name: 'Two' });
    session.controller.adoptProject({ ...session.controller.getProject(), name: 'Three' });
    await settle();

    expect(main.sent).toHaveLength(1);
    expect(JSON.parse(main.sent[0].payload as string).name).toBe('Three');
  });

  it('skips destroyed windows and leaves other sessions silent', async () => {
    const session = createSession();
    const other = createSession();
    const live = fakeWindow(10);
    const dead = fakeWindow(11);
    dead.destroyed = true;
    const untouched = fakeWindow(12);
    addWindow(session.id, live);
    addWindow(session.id, dead);
    addWindow(other.id, untouched);
    attachSessionEditorPush(session);

    session.controller.adoptProject({ ...session.controller.getProject(), name: 'x' });
    await settle();

    expect(live.sent).toHaveLength(1);
    expect(dead.sent).toEqual([]);
    expect(untouched.sent).toEqual([]);
  });
});

describe('renderer-originated editor sync', () => {
  it('reaches a same-session detached panel and skips every other window', async () => {
    const session = createSession();
    const other = createSession();
    const main = fakeWindow(1);
    const detached = fakeWindow(2);
    const otherMain = fakeWindow(3);
    addWindow(session.id, main);
    addWindow(session.id, detached);
    addWindow(other.id, otherMain);
    attachSessionEditorPush(session);

    const project = { ...session.controller.getProject(), name: 'Edited in main' };
    const response = await syncFrom(1, project);
    await settle();

    expect(response).toEqual({ success: true, sequence: 1 });
    expect(session.controller.getProject().name).toBe('Edited in main');
    expect(main.calls).toEqual([]);
    expect(otherMain.calls).toEqual([]);
    // setProjectSilent did not notify the controller subscription, so the
    // tagged sibling message is the only delivery and cannot start an echo.
    expect(detached.calls).toHaveLength(1);
    expect(detached.calls[0].channel).toBe('editor:apply-from-main');
    expect(JSON.parse(detached.calls[0].args[0] as string).name).toBe('Edited in main');
    expect(detached.calls[0].args[1]).toEqual({ source: 'renderer', sequence: 1 });
  });

  it('does not add history on the main mirror or route another session', async () => {
    const session = createSession();
    const other = createSession();
    const main = fakeWindow(1);
    const detached = fakeWindow(2);
    const otherMain = fakeWindow(3);
    addWindow(session.id, main);
    addWindow(session.id, detached);
    addWindow(other.id, otherMain);

    const response = await syncFrom(1, {
      ...session.controller.getProject(),
      name: 'No undo entry',
    });

    expect(response).toMatchObject({ success: true });
    expect(session.controller.canUndo()).toBe(false);
    expect(other.controller.getProject().name).not.toBe('No undo entry');
    expect(otherMain.calls).toEqual([]);
  });

  it('assigns bounded, ordered sibling events for concurrent syncs', async () => {
    const session = createSession();
    const windows = [fakeWindow(1), fakeWindow(2), fakeWindow(3), fakeWindow(4)];
    for (const window of windows) addWindow(session.id, window);

    const responses = await Promise.all(windows.map((window, index) => syncFrom(
      window.id,
      { ...session.controller.getProject(), name: `edit-${index}` },
    )));
    const sequences = responses.map((response) => (
      response as { sequence: number }
    ).sequence);
    expect(sequences).toEqual([1, 2, 3, 4]);

    // Each source receives no echo. Every other window receives one message
    // per concurrent sync, and no handler can recursively generate another
    // main-side controller notification.
    for (const [index, window] of windows.entries()) {
      expect(window.calls).toHaveLength(windows.length - 1);
      expect(window.calls.map(({ args }) => args[1])).toEqual(
        sequences
          .filter((_, sequenceIndex) => sequenceIndex !== index)
          .map((sequence) => ({ source: 'renderer', sequence })),
      );
    }

    // Model the receiver gate used by useEditorSync: each sender starts with
    // its acknowledgement, and deliveries are deliberately consumed newest
    // first. The sequence gate ignores old deliveries, so every window lands
    // on main's final accepted snapshot and a replay is a no-op.
    interface ReceiverState {
      sequence: number;
      name: string;
    }
    const receiverStates: ReceiverState[] = windows.map((_, index) => ({
      sequence: sequences[index],
      name: `edit-${index}`,
    }));
    let applications = 0;
    const apply = (state: ReceiverState, sequence: number, name: string): void => {
      if (sequence <= state.sequence) return;
      state.sequence = sequence;
      state.name = name;
      applications += 1;
    };
    for (const [index, window] of windows.entries()) {
      const deliveries = window.calls
        .map(({ args }) => ({
          sequence: (args[1] as { sequence: number }).sequence,
          name: JSON.parse(args[0] as string).name as string,
        }))
        .sort((left, right) => right.sequence - left.sequence);
      for (const delivery of deliveries) apply(receiverStates[index], delivery.sequence, delivery.name);
      expect(receiverStates[index].name).toBe(session.controller.getProject().name);
      const afterFirstPass = applications;
      for (const delivery of deliveries) apply(receiverStates[index], delivery.sequence, delivery.name);
      expect(applications).toBe(afterFirstPass);
    }
    expect(applications).toBeLessThanOrEqual(windows.length * (windows.length - 1));
  });
});

describe('sender → controller resolution (handler half)', () => {
  it('routes each window to its own session’s controller', () => {
    const a = createSession();
    const b = createSession();
    addWindow(a.id, fakeWindow(1));
    addWindow(b.id, fakeWindow(2));

    // Same expression every editor:* handler uses in main.
    expect(getSessionForSender({ id: 1 })?.controller).toBe(a.controller);
    expect(getSessionForSender({ id: 2 })?.controller).toBe(b.controller);
    expect(getSessionForSender({ id: 999 })).toBeNull();
  });
});

/**
 * Regression: `editor:undo` / `editor:redo` must really call the sender's
 * controller. They once returned a hardcoded `success: true` while never
 * invoking undo/redo, so Agent/MCP undo reported success and changed nothing.
 */
describe('editor:undo / editor:redo', () => {
  function invoke(channel: 'editor:undo' | 'editor:redo', windowId: number): {
    success: boolean;
    data: { name: string };
    error?: string;
  } {
    const handler = electronMocks.handlers.get(channel);
    if (!handler) throw new Error(`${channel} handler was not registered`);
    return handler({ sender: { id: windowId } }) as {
      success: boolean;
      data: { name: string };
      error?: string;
    };
  }

  /** A main-side (agent/MCP) edit: one undoable history entry. */
  function mainSideEdit(controller: EditorController, name: string): void {
    controller.adoptProject({ ...controller.getProject(), name });
  }

  it('undoes a main-process edit and reports success', () => {
    const session = createSession();
    addWindow(session.id, fakeWindow(1));
    const original = session.controller.getProject().name;

    mainSideEdit(session.controller, 'Agent rename');
    expect(session.controller.getProject().name).toBe('Agent rename');

    const response = invoke('editor:undo', 1);

    expect(response.success).toBe(true);
    expect(response.data.name).toBe(original);
    expect(session.controller.getProject().name).toBe(original);
    expect(session.controller.canUndo()).toBe(false);
  });

  it('re-applies the undone edit with redo', () => {
    const session = createSession();
    addWindow(session.id, fakeWindow(1));

    mainSideEdit(session.controller, 'Agent rename');
    invoke('editor:undo', 1);
    expect(session.controller.getProject().name).not.toBe('Agent rename');

    const response = invoke('editor:redo', 1);

    expect(response.success).toBe(true);
    expect(response.data.name).toBe('Agent rename');
    expect(session.controller.getProject().name).toBe('Agent rename');
  });

  it('reports failure — not a hardcoded true — with nothing to undo or redo', () => {
    const session = createSession();
    addWindow(session.id, fakeWindow(1));

    expect(invoke('editor:undo', 1).success).toBe(false);
    expect(invoke('editor:redo', 1).success).toBe(false);

    // Second undo drains the single history entry, so the repeat is a no-op
    // that must not claim to have changed anything.
    mainSideEdit(session.controller, 'Agent rename');
    expect(invoke('editor:undo', 1).success).toBe(true);
    expect(invoke('editor:undo', 1).success).toBe(false);
  });

  it('mirrors the controller return value instead of re-deriving it', () => {
    const session = createSession();
    addWindow(session.id, fakeWindow(1));
    mainSideEdit(session.controller, 'Agent rename');

    // A controller that refuses the undo while `canUndo()` is still true: only
    // a handler that forwards the real return value can report this honestly.
    const undo = vi.spyOn(session.controller, 'undo').mockReturnValue(false);

    const response = invoke('editor:undo', 1);

    expect(undo).toHaveBeenCalledTimes(1);
    expect(response.success).toBe(false);
    expect(response.data.name).toBe('Agent rename');
  });

  it('undoes only the sender’s session, leaving the other project untouched', () => {
    const a = createSession();
    const b = createSession();
    addWindow(a.id, fakeWindow(1));
    addWindow(b.id, fakeWindow(2));
    const aNameBefore = a.controller.getProject().name;
    const bNameBefore = b.controller.getProject().name;

    mainSideEdit(a.controller, 'A agent');
    mainSideEdit(b.controller, 'B agent');

    const response = invoke('editor:undo', 1);

    // Undo returns the snapshot captured before the adopt, and `data` is the
    // post-undo project.
    expect(response.success).toBe(true);
    expect(response.data.name).toBe(aNameBefore);
    expect(a.controller.getProject().name).toBe(aNameBefore);
    expect(a.controller.canUndo()).toBe(false);
    // Session B keeps its edit and its history: no cross-session undo.
    expect(b.controller.getProject().name).toBe('B agent');
    expect(b.controller.canUndo()).toBe(true);

    // ...and B's own sender still undoes B, which A cannot see or redo for it.
    expect(invoke('editor:undo', 2).data.name).toBe(bNameBefore);
    expect(b.controller.canUndo()).toBe(false);
    expect(a.controller.getProject().name).toBe(aNameBefore);
  });

  it('refuses an unknown sender with NO_SESSION_ERROR', () => {
    expect(invoke('editor:undo', 999)).toEqual({
      success: false,
      error: NO_SESSION_ERROR,
    });
    expect(invoke('editor:redo', 999)).toEqual({
      success: false,
      error: NO_SESSION_ERROR,
    });
  });

  it('leaves renderer-sync propagation intact while undoing', async () => {
    const session = createSession();
    const other = createSession();
    const main = fakeWindow(1);
    const detached = fakeWindow(2);
    const otherMain = fakeWindow(3);
    addWindow(session.id, main);
    addWindow(session.id, detached);
    addWindow(other.id, otherMain);
    attachSessionEditorPush(session);

    // A main-side (agent/MCP) edit still pushes the untagged payload to both
    // of this session's windows and nowhere else.
    mainSideEdit(session.controller, 'Agent rename');
    await settle();
    expect(main.calls).toHaveLength(1);
    expect(detached.calls).toHaveLength(1);
    expect(otherMain.calls).toEqual([]);

    // A renderer edit still propagates to siblings only: tagged, acknowledged,
    // and never echoed to its own sender.
    const response = await syncFrom(1, {
      ...session.controller.getProject(),
      name: 'Edited in main',
    });
    await settle();
    expect(response).toEqual({ success: true, sequence: 1 });
    expect(main.calls).toHaveLength(1);
    expect(detached.calls).toHaveLength(2);
    expect(detached.calls[1].args[1]).toEqual({ source: 'renderer', sequence: 1 });
    expect(JSON.parse(detached.calls[1].args[0] as string).name).toBe('Edited in main');
    expect(otherMain.calls).toEqual([]);

    // Undo does NOT reach past the renderer snapshot. The agent edit captured
    // its inverse before the user's project arrived, so undoing it now would
    // discard the work the user just did — the whole-document case replacing
    // the project outright, the per-clip case silently reverting one clip. The
    // undo refuses, the renderer's project stays, and there is nothing to redo
    // because nothing was undone. The renderer snapshot still authored no undo
    // step here, which is what the previous expectation also asserted.
    const undo = invoke('editor:undo', 1);
    expect(undo.success).toBe(false);
    expect(session.controller.getProject().name).toBe('Edited in main');
    expect(session.controller.canRedo()).toBe(false);
    expect(session.controller.getUndoRefusal()).toBe('stale');
  });

  it('reports why the undo refused, so a caller can tell it from an empty stack', async () => {
    // `success: false` alone is ambiguous: it covers both "there was nothing to
    // undo" and "undoing now would overwrite work since". The agent surface
    // already distinguishes them, and the IPC now does too, in the same `error`
    // field this handler already uses for its other failure.
    const session = createSession();
    addWindow(session.id, fakeWindow(1));

    // An empty stack: no reason, so the shape stays exactly as it was.
    expect(invoke('editor:undo', 1)).toEqual({
      success: false,
      data: expect.objectContaining({ name: expect.any(String) }),
    });

    mainSideEdit(session.controller, 'Agent rename');
    await syncFrom(1, { ...session.controller.getProject(), name: 'Edited in main' });

    const refused = invoke('editor:undo', 1);
    expect(refused.success).toBe(false);
    expect(refused.error).toBe(
      'Cannot undo: the project changed since that step was applied, so undoing it would '
      + 'overwrite work done since. Undo it from the window instead.',
    );
    // Same wording as the agent's receipt: one source, so the two cannot drift.
    expect(refused.error).toBe(session.controller.undoRefusalMessage('undo'));
  });

  it('a playhead-only push leaves the main-side undo working', async () => {
    // The IPC shape of the correction: a cursor move reaches main on nearly
    // every push, and it must not cost the caller an undo.
    const session = createSession();
    addWindow(session.id, fakeWindow(1));
    mainSideEdit(session.controller, 'Agent rename');
    expect(session.controller.getProject().name).toBe('Agent rename');

    const project = session.controller.getProject();
    await syncFrom(1, {
      ...project,
      timeline: { ...project.timeline, playheadFrame: 99 },
    });

    const undone = invoke('editor:undo', 1);
    expect(undone.success).toBe(true);
    expect(undone).not.toHaveProperty('error');
    expect(session.controller.getProject().name).not.toBe('Agent rename');
  });
});
