/**
 * The debounced main-side push must serialize the project main holds AT SEND
 * TIME, not the one it held when its controller notified.
 *
 * The defect this pins: `attachSessionEditorPush` closed over the subscriber's
 * `project` argument, so the payload was frozen at notify time. `setProjectSilent`
 * — the mirror write the renderer's own push performs — does not notify, so
 * nothing re-armed the timer and nothing refreshed the captured project. A
 * renderer push landing inside main's 30 ms window therefore left main holding
 * the renderer's newer state while the pending timer still carried the older
 * snapshot, and the window adopted that snapshot back:
 *
 *   1. an agent edit notifies, arming the timer with snapshot P1;
 *   2. the user edits, and their push reaches main, which adopts it silently
 *      (main now holds the user's S1, and the timer still carries P1);
 *   3. the timer fires and sends P1;
 *   4. the window is told about a project it is not an echo of, has no pending
 *      write (its own push was just acknowledged), so it adopts P1 and the
 *      user's edit is reverted. `mirror.markConfirmed` then records main as
 *      holding P1, which it does not.
 *
 * That is data loss with no drop involved at all — a distinct failure from the
 * pending-local refusal, which is reported, not silent. It is also the thing
 * that would resurrect under any future rebase or replay, which is why it has
 * to go first.
 *
 * Both sides are real and in one process: main's session controller with its
 * 30 ms debounce, and the renderer's `createEditorSync` with its 300 ms one,
 * wired to each other the way the IPC channels wire them. Nothing about the
 * drop, the notice, the 30 ms collapse window or the version guard is under
 * test here — only which project gets serialized.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachSessionEditorPush, registerEditorSyncHandlers } from './editor-sync';
import {
  addWindow,
  createSession,
  resetSessions,
  type Session,
  type SessionWindow,
} from '../sessions';
import { useProjectStore } from '../../renderer/store/project';
import { useTimelineStore } from '../../renderer/store/timeline';
import { createEditorSync, type EditorSync } from '../../renderer/hooks/useEditorSync';
import { createEmptyProject, type Project } from '../../shared/types/project';

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

/** useEditorSync's own debounce, restated so the schedule reads in one place. */
const RENDERER_DEBOUNCE_MS = 300;
/** attachSessionEditorPush's collapse window. */
const MAIN_WINDOW_MS = 30;
/** How late the agent lands, so its window straddles the renderer's push. */
const AGENT_EDIT_AT_MS = RENDERER_DEBOUNCE_MS - 10;

const WINDOW_ID = 1;

interface TestWindow extends SessionWindow {
  calls: Array<{ channel: string; args: unknown[] }>;
  destroyed: boolean;
}

function fakeWindow(id: number, onSend?: (payload: unknown, metadata?: unknown) => void): TestWindow {
  const win = {
    id,
    destroyed: false,
    calls: [] as Array<{ channel: string; args: unknown[] }>,
    isDestroyed: () => win.destroyed,
    send: (channel: string, ...args: unknown[]) => {
      win.calls.push({ channel, args });
      if (channel === 'editor:apply-from-main' && onSend) onSend(args[0], args[1]);
    },
  };
  return win;
}

/** The real `editor:sync-from-renderer` handler, driven as the window would. */
function syncFromRenderer(project: unknown): Promise<unknown> {
  const handler = electronMocks.handlers.get('editor:sync-from-renderer');
  if (!handler) throw new Error('editor sync handler was not registered');
  return Promise.resolve(handler({ sender: { id: WINDOW_ID } }, JSON.stringify(project)));
}

function renderer() {
  return useTimelineStore.getState().controller;
}

function rendererName(): string {
  return useTimelineStore.getState().controller.getProject().name;
}

function rendererClipStarts(): number[] {
  return useTimelineStore.getState().controller.getClips().map((clip) => clip.startFrame);
}

/**
 * The project both sides open on. Rebuilt per test so a clip id minted by one
 * test cannot be shared with the next.
 */
function baseline(): Project {
  return createEmptyProject('Shared');
}

interface Wired {
  sync: EditorSync;
  session: Session;
  win: TestWindow;
  /** Every project this window sent to main, in order. */
  pushes: string[];
}

let wired: Wired | null = null;

/**
 * Mount one window against one session, with the two ends really connected.
 *
 * `pushSnapshot` goes through the registered IPC handler, so main adopts the
 * renderer's project by exactly the route production uses, and the fake window
 * feeds main's sends straight into the renderer's listener.
 */
async function mountWindow(): Promise<Wired> {
  const pushes: string[] = [];
  const session = createSession();
  let sync: EditorSync;
  const win = fakeWindow(WINDOW_ID, (payload, metadata) => {
    for (const listener of [...listeners]) listener(payload, metadata);
  });
  const listeners: Array<(payload: unknown, metadata?: unknown) => void> = [];
  addWindow(session.id, win);
  attachSessionEditorPush(session);
  sync = createEditorSync({
    controller: renderer(),
    pullSessionState: async () => ({ project: null, filePath: null }),
    pushSnapshot: async (payload, _filePath) => {
      pushes.push(payload);
      return syncFromRenderer(JSON.parse(payload));
    },
    onApply: (listener) => {
      listeners.push(listener);
      return () => {
        listeners.splice(listeners.indexOf(listener), 1);
      };
    },
    reportSessionPath: async () => ({ success: true }),
  });
  const result: Wired = { sync, session, win, pushes };
  wired = result;
  return result;
}

beforeAll(() => {
  registerEditorSyncHandlers();
});

beforeEach(() => {
  vi.useFakeTimers();
  resetSessions();
  electronMocks.fromWebContents.mockReset();
  electronMocks.fromWebContents.mockReturnValue(null);
  // The window holds a project of its own, so it mirrors rather than adopts.
  renderer().loadProject(baseline());
  useProjectStore.setState({
    name: 'Shared',
    filePath: null,
    isLoaded: true,
    hasUnsavedChanges: false,
    droppedSync: null,
  });
});

afterEach(() => {
  wired?.sync.dispose();
  wired = null;
  vi.useRealTimers();
  resetSessions();
});

/** What the agent's tool executor does to the session controller mid-turn. */
function agentEdit(session: Session, name: string): void {
  session.controller.adoptProject({ ...session.controller.getProject(), name });
}

/** What the user does in the window: a real edit, which arms their debounce. */
function userEdit(): void {
  renderer().addClip({ assetId: 'asset-1', trackId: 'v1', startFrame: 30, durationFrames: 60 });
}

describe('the main-side push serializes the project main holds at send time', () => {
  it('keeps the user edit whose push landed inside the collapse window', async () => {
    const { sync, session, pushes } = await mountWindow();
    await sync.ready;
    // The mount-time seed: both ends now hold the same baseline.
    expect(session.controller.getProject().name).toBe('Shared');
    expect(pushes).toHaveLength(1);

    // t=0: the user edits. Their push is armed for +300ms.
    userEdit();

    // t=290: the agent, mid-turn, makes an edit. Main's window is armed for
    // +30ms, so it will fire at 320 — after the renderer's push at 300.
    await vi.advanceTimersByTimeAsync(AGENT_EDIT_AT_MS);
    agentEdit(session, 'Agent turn');
    expect(session.controller.getProject().name).toBe('Agent turn');

    // t=300: the renderer's push lands and main adopts it SILENTLY. Main now
    // holds the user's state; the pending timer still carries 'Agent turn'.
    await vi.advanceTimersByTimeAsync(RENDERER_DEBOUNCE_MS - AGENT_EDIT_AT_MS);
    expect(pushes).toHaveLength(2);
    expect(session.controller.getProject().name).toBe('Shared');
    expect(session.controller.getClips().map((clip) => clip.startFrame)).toEqual([30]);

    // t=320: main's window fires.
    await vi.advanceTimersByTimeAsync(MAIN_WINDOW_MS);

    // The user's clip is still there, and no stale snapshot was adopted over it.
    // Captured at notify time this payload would have been 'Agent turn' with no
    // clips, which the window would have taken as an agent edit and made the
    // user's clip vanish with an 'AI edit' undo entry to prove it.
    expect(session.controller.getProject().name).toBe('Shared');
    expect(rendererName()).toBe('Shared');
    expect(rendererClipStarts()).toEqual([30]);
    // And adopting nothing means no undo step was charged for a cursor of an
    // agent turn the user never saw.
    expect(renderer().canUndo()).toBe(true);
    expect(renderer().undo()).toBe(true);
    expect(rendererClipStarts()).toEqual([]);
  });

  it('still sends the notified project when nothing intervened', async () => {
    const { sync, session, win } = await mountWindow();
    await sync.ready;
    const before = win.calls.length;

    agentEdit(session, 'Agent rename');
    await vi.advanceTimersByTimeAsync(MAIN_WINDOW_MS);

    const pushed = win.calls[before].args[0] as string;
    expect(JSON.parse(pushed).name).toBe('Agent rename');
    // So the fix is not "always send whatever is newest": with no intervening
    // change, newest and notified are the same project, and it is that one.
    expect(JSON.parse(pushed)).toEqual(JSON.parse(JSON.stringify(session.controller.getProject())));
    expect(win.calls[before].args[1]).toEqual({ source: 'main', kind: 'edit' });
  });

  it('absorbs its own state when the renderer push is all that happened', async () => {
    const { sync, session, win, pushes } = await mountWindow();
    await sync.ready;

    // An agent edit whose window fires with the renderer's own project as the
    // newest state: the send-time re-read can now echo the window's own
    // snapshot back at it. That is only harmless if the echo check is right, so
    // it is asserted rather than assumed. The 'Shared' name keeps both ends
    // byte-identical, which is exactly the echo case.
    const before = win.calls.length;
    agentEdit(session, 'Shared');
    await vi.advanceTimersByTimeAsync(MAIN_WINDOW_MS);

    const delivered = JSON.parse(win.calls[before].args[0] as string);
    expect(delivered.name).toBe('Shared');
    expect(rendererName()).toBe('Shared');
    // Nothing was adopted, so no undo entry and no project churn.
    expect(renderer().canUndo()).toBe(false);
    // And it stops there: the window does not push a new snapshot in response
    // to receiving one, so there is no ping-pong.
    const pushesAfter = pushes.length;
    await vi.advanceTimersByTimeAsync(RENDERER_DEBOUNCE_MS * 2);
    expect(pushes).toHaveLength(pushesAfter);
  });
});

describe('the collapse window still collapses a whole turn', () => {
  it('reports edit-then-cursor as an edit, in both orders', async () => {
    for (const order of ['playhead-first', 'edit-first'] as const) {
      resetSessions();
      const { sync, session, win } = await mountWindow();
      await sync.ready;
      const before = win.calls.length;

      const parkCursor = (): void => session.controller.setPlayhead(90);
      const edit = (): void => agentEdit(session, 'Agent rename');
      if (order === 'playhead-first') {
        parkCursor();
        edit();
      } else {
        edit();
        parkCursor();
      }
      await vi.advanceTimersByTimeAsync(MAIN_WINDOW_MS);

      // One push, and the tag describes the collapsed window rather than
      // whichever notification arrived last.
      expect(win.calls.length - before).toBe(1);
      expect(win.calls[before].args[1]).toEqual({ source: 'main', kind: 'edit' });
      // The newest project, and the cursor the turn ended on.
      const pushed = JSON.parse(win.calls[before].args[0] as string);
      expect(pushed.name).toBe('Agent rename');
      expect(pushed.timeline.playheadFrame).toBe(90);
      sync.dispose();
    }
  });

  it('still reports a cursor-only window as a playhead', async () => {
    const { sync, session, win } = await mountWindow();
    await sync.ready;
    const before = win.calls.length;

    session.controller.setPlayhead(120);
    await vi.advanceTimersByTimeAsync(MAIN_WINDOW_MS);

    expect(win.calls[before].args[1]).toEqual({ source: 'main', kind: 'playhead' });
    expect(JSON.parse(win.calls[before].args[0] as string).timeline.playheadFrame).toBe(120);
    // A view update is still free: the seed push armed no window, so the
    // cursor move published no history on either side.
    expect(session.controller.canUndo()).toBe(false);
  });
});
