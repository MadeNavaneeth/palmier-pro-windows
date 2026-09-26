/**
 * Editor state sync (renderer <-> main), routed per session (#137 Slice 1).
 *
 * Each window's renderer timeline controller is the authoritative source of
 * truth for its session, so UI editing stays local and fast. This module
 * keeps that session's main-process controller mirrored to it, and pushes
 * agent/MCP edits back — to that session's windows only:
 *
 *   renderer edits  -> editor:sync-from-renderer -> session.controller.setProjectSilent (no echo)
 *                      -> tagged editor:apply-from-main -> sibling renderers (silent adoption)
 *   agent/MCP edits -> session.controller change  -> editor:apply-from-main
 *                       -> main window + detached panels of THAT session
 *
 * setProjectSilent does not notify, so mirroring the renderer never triggers a
 * push back; only genuine main-side (agent/MCP) edits use the ordinary
 * controller subscription below. Renderer-origin propagation is explicit in
 * the sync handler and carries a sequence in the second event argument. The
 * first argument is always the project JSON; the second says WHERE the state
 * came from, in two shapes the receiving side tells apart:
 *
 *   { source: 'renderer', sequence }  a sibling window's write
 *   { source: 'main', kind }          a main-side (agent/MCP) notification
 *
 * The main-side kind is the controller's own verdict, forwarded rather than
 * re-derived. The renderer already has `sameProjectExceptPlayhead` for the
 * sibling case, where no sender volunteered a verdict, but on the main-side
 * path a value comparison could not tell a cursor move from an agent call that
 * changed nothing, and it is the only party that knows which happened: an
 * `adoptProject` from the agent tool executor publishes a command, a
 * `setPlayhead` does not. So the receiving window adopts a tagged `edit` as the
 * one undoable step it always was, and a tagged `playhead` as the view update
 * it is, and the untagged form stays the conservative undoable default for any
 * push that arrives without one.
 */

import { ipcMain, BrowserWindow } from 'electron';
import { ToolExecutor } from '../ai/executor';
import { sessionProjectPathOf } from './project';
import type { EditorController, StateChangeKind } from '../../shared/editor/controller';
import type { Project } from '../../shared/types/project';
import {
  NO_SESSION_ERROR,
  getSessionForSender,
  type Session,
  type SessionSender,
} from '../sessions';

const RENDERER_SYNC_SOURCE = 'renderer';
const MAIN_SYNC_SOURCE = 'main';

/**
 * Main-process order for renderer snapshots. The sender is acknowledged with
 * the same sequence, so it can reject an older sibling event that arrives
 * after its own concurrent snapshot has already won the session.
 */
const rendererSyncSequences = new WeakMap<Session, number>();

/** One ToolExecutor per session controller, built on first use. */
const executors = new WeakMap<EditorController, ToolExecutor>();

function executorFor(controller: EditorController): ToolExecutor {
  let executor = executors.get(controller);
  if (!executor) {
    executor = new ToolExecutor(controller);
    executors.set(controller, executor);
  }
  return executor;
}

function controllerForSender(sender: SessionSender): EditorController | null {
  return getSessionForSender(sender)?.controller ?? null;
}

/**
 * Send a renderer-originated snapshot to sibling windows in one session.
 * The source window is skipped: it already has the state it sent, and the
 * handler returns the sequence as its acknowledgement. The session's window
 * map is the isolation boundary; no process-wide window list is consulted.
 */
function broadcastRendererSync(
  session: Session,
  senderId: number,
  project: Project,
): number {
  const sequence = (rendererSyncSequences.get(session) ?? 0) + 1;
  rendererSyncSequences.set(session, sequence);

  const payload = JSON.stringify(project);
  for (const contents of session.windows.values()) {
    if (contents.id === senderId || contents.isDestroyed()) continue;
    contents.send('editor:apply-from-main', payload, {
      source: RENDERER_SYNC_SOURCE,
      sequence,
    });
  }
  return sequence;
}

export function registerEditorSyncHandlers(
  onRendererSync?: (project: Project, win: BrowserWindow | null) => Promise<void> | void,
): void {
  ipcMain.handle(
    'editor:execute',
    async (event, commandName: string, args: Record<string, unknown>) => {
      const controller = controllerForSender(event.sender);
      if (!controller) return { success: false, error: NO_SESSION_ERROR };
      return executorFor(controller).execute(commandName, args);
    },
  );
  // The session's authoritative project, plus the file it is held in. A window
  // that reloaded rebuilt its store around a fresh empty controller, so this
  // pull is the only thing that puts the document back in front of the user; the
  // path rides along because the project document does not carry its own, and a
  // window that lost it degrades Save into Save As (see ipc/project.ts).
  ipcMain.handle('editor:get-state', (event) => {
    const session = getSessionForSender(event.sender);
    if (!session) return { success: false, error: NO_SESSION_ERROR };
    return {
      success: true,
      data: session.controller.getProject(),
      filePath: sessionProjectPathOf(session),
    };
  });
  // `success` is the controller's real boolean, never a constant: undo/redo
  // with an empty history must report failure so Agent/MCP callers do not
  // believe a no-op mutated the timeline.
  ipcMain.handle('editor:undo', (event) => {
    const controller = controllerForSender(event.sender);
    if (!controller) return { success: false, error: NO_SESSION_ERROR };
    return { success: controller.undo(), data: controller.getProject() };
  });
  ipcMain.handle('editor:redo', (event) => {
    const controller = controllerForSender(event.sender);
    if (!controller) return { success: false, error: NO_SESSION_ERROR };
    return { success: controller.redo(), data: controller.getProject() };
  });

  // Renderer pushes its authoritative project to main (no history, no echo).
  ipcMain.handle('editor:sync-from-renderer', async (event, projectJson: string) => {
    const session = getSessionForSender(event.sender);
    if (!session) return { success: false, error: NO_SESSION_ERROR };
    try {
      session.controller.setProjectSilent(JSON.parse(projectJson));
      const project = session.controller.getProject();
      // Explicitly propagate renderer edits without notifying the controller;
      // siblings adopt this tagged snapshot through setProjectSilent as well.
      const sequence = broadcastRendererSync(session, event.sender.id, project);
      await onRendererSync?.(
        project,
        BrowserWindow.fromWebContents(event.sender),
      );
      return { success: true, sequence };
    } catch (err: unknown) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
}

/**
 * Push this session's main-side changes (agent / MCP) to ITS windows — the
 * main window plus its detached panels, never another session's windows —
 * debounced so a multi-tool agent turn collapses into a single UI update.
 *
 * The debounced window collapses a turn, so the kind it carries is the kind of
 * the WHOLE window, not of the notification that happened to arrive last: an
 * agent that edits and then parks the cursor has still made an edit, and a
 * window that adopted that snapshot as a view update would take the edit off
 * the undo stack and leave the project clean. Only a window in which every
 * notification was a cursor move is reported as `playhead`, which is exactly
 * the claim the receiving side acts on.
 *
 * Attached once when the session's main window is created; the subscription
 * lives and dies with the session's controller, so teardown needs no explicit
 * unsubscribe.
 */
export function attachSessionEditorPush(session: Session): void {
  let pushTimer: ReturnType<typeof setTimeout> | null = null;
  let collapsedKind: StateChangeKind = 'playhead';
  session.controller.subscribe((project, kind) => {
    if (kind === 'edit') collapsedKind = 'edit';
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      pushTimer = null;
      const metadata = { source: MAIN_SYNC_SOURCE, kind: collapsedKind };
      collapsedKind = 'playhead';
      const payload = JSON.stringify(project);
      for (const contents of session.windows.values()) {
        if (contents.isDestroyed()) continue;
        contents.send('editor:apply-from-main', payload, metadata);
      }
    }, 30);
  });
}
