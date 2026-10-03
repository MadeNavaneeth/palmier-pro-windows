/**
 * Multi-window session registry (upstream #137).
 *
 * One Electron process hosts N main windows; each window owns one session:
 * a minted id, its own EditorController (project + undo history), its own
 * PalmierAgent (built lazily on the first chat, Slice 2), its own recovery
 * file (see ipc/autosave.ts), and its own detached-panel set (see
 * application.ts). Detached panel windows join their parent's session, so a
 * panel always mirrors the workspace that opened it.
 *
 * IPC routing is sender-based: every project/editor handler resolves the
 * session from `event.sender` through `getSessionForSender`, so channel names
 * and payload shapes stay exactly as they were under the single-controller
 * build. sessionId is minted here (crypto), never accepted from the renderer.
 *
 * Electron-free on purpose: windows are narrowed to the structural surface a
 * real WebContents already satisfies, so the whole registry is unit-testable
 * in plain node like windows/detached-panels.ts.
 */

import crypto from 'crypto';
import { EditorController } from '../shared/editor/controller';
import type { PalmierAgent } from './ai/agent';

/** What this module needs from a window's WebContents. */
export interface SessionWindow {
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
}

/** Structural shape of an IPC sender (`event.sender`) for session lookup. */
export interface SessionSender {
  readonly id: number;
}

export interface Session {
  /** Minted once per main window; stable for the window's lifetime. */
  readonly id: string;
  /** This session's main-process project mirror + undo history. */
  readonly controller: EditorController;
  /** Main window first, detached panels joined — keyed by webContents id. */
  readonly windows: Map<number, SessionWindow>;
  /**
   * This session's PalmierAgent, built lazily on the first chat (#137 Slice 2).
   * Owned here so `removeSession` can cancel an in-flight turn on window close
   * instead of leaving it streaming into a dead renderer.
   */
  agent?: PalmierAgent;
}

/** Returned by handlers when a sender belongs to no session (never in normal operation). */
export const NO_SESSION_ERROR = 'No session for this window.';

const sessions = new Map<string, Session>();
const windowToSession = new Map<number, string>();

/**
 * The session that owns a controller.
 *
 * The reverse of `Session.controller`, and the answer the AI tool layer needs:
 * a `ToolExecutor` is built from a controller — one per session for the
 * in-app agent and for `editor:execute`, a fresh one per MCP request — so it
 * can name the session it is running against without any caller passing an id.
 * One controller is minted per session in `createSession` and the session owns
 * it for life, so this is one-way and cannot go stale; a controller no session
 * owns (every unit test builds its own) resolves to nothing, which is the
 * honest answer: there is no window to keep a document path for.
 */
const sessionsByController = new WeakMap<EditorController, Session>();

/**
 * The session MCP tools target when a request carries no explicit id: the
 * most recently focused main window (application.ts marks focus on it),
 * falling back to the first live session when the marked one is gone.
 */
let activeSessionId: string | null = null;

/** Mint a fresh session with its own controller. The new window starts active. */
export function createSession(): Session {
  const session: Session = {
    id: crypto.randomUUID(),
    controller: new EditorController(),
    windows: new Map(),
  };
  sessions.set(session.id, session);
  sessionsByController.set(session.controller, session);
  markSessionActive(session.id);
  return session;
}

/** Point the "active session" designation at a live session. Unknown ids are ignored. */
export function markSessionActive(sessionId: string): void {
  if (sessions.has(sessionId)) activeSessionId = sessionId;
}

/**
 * The session an untargeted MCP request acts on (#137 Slice 2): the marked
 * one when it still exists, otherwise the first session in mint order.
 */
export function getActiveSession(): Session | null {
  const marked = activeSessionId !== null ? sessions.get(activeSessionId) ?? null : null;
  return marked ?? listSessions()[0] ?? null;
}

/** Attach a window (main or detached) to a session. False when the session is gone. */
export function addWindow(sessionId: string, contents: SessionWindow): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  session.windows.set(contents.id, contents);
  windowToSession.set(contents.id, sessionId);
  return true;
}

/** Drop one closed window from the lookup; the session survives its panels. */
export function removeWindow(windowId: number): void {
  const sessionId = windowToSession.get(windowId);
  if (!sessionId) return;
  windowToSession.delete(windowId);
  sessions.get(sessionId)?.windows.delete(windowId);
}

/** Remove a session and every window lookup pointing at it (main window closed). */
export function removeSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  // The workspace is gone: stop its agent's turn so no orphaned turn keeps
  // running against windows that are about to die (#137 Slice 2).
  session.agent?.cancel();
  if (activeSessionId === sessionId) activeSessionId = null;
  for (const windowId of session.windows.keys()) windowToSession.delete(windowId);
  sessions.delete(sessionId);
}

export function getSession(sessionId: string): Session | null {
  return sessions.get(sessionId) ?? null;
}

/** Resolve an IPC sender's session (main window or one of its detached panels). */
export function getSessionForSender(sender: SessionSender | null | undefined): Session | null {
  if (!sender) return null;
  const sessionId = windowToSession.get(sender.id);
  return sessionId ? sessions.get(sessionId) ?? null : null;
}

/** The session that owns this controller, or null when none does. */
export function sessionForController(
  controller: EditorController | null | undefined,
): Session | null {
  if (!controller) return null;
  return sessionsByController.get(controller) ?? null;
}

export function listSessions(): Session[] {
  return [...sessions.values()];
}

/**
 * Fan a message out to one session's live windows only — the main workspace
 * plus its detached panels, never another session's windows.
 */
export function broadcastToSession(sessionId: string, channel: string, payload: unknown): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  for (const contents of session.windows.values()) {
    if (!contents.isDestroyed()) contents.send(channel, payload);
  }
}

/** Test seam: forget every session (mirrors resetMarkerSettingsCache). */
export function resetSessions(): void {
  sessions.clear();
  windowToSession.clear();
  activeSessionId = null;
}
