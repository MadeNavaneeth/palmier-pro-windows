/**
 * Per-session PalmierAgent registry (upstream #137, Slice 2).
 *
 * Each session owns at most one agent, constructed lazily against that
 * session's controller, so two windows chat concurrently without sharing
 * history, busy state, or cancel — and a session that never chatted has no
 * agent at all. The agent lives on the Session itself (see sessions.ts), so
 * `removeSession` cancels it on window close: no orphaned turn keeps running.
 *
 * Electron-free on purpose, like sessions.ts and windows/detached-panels.ts:
 * the whole registry is unit-testable in plain node.
 */

import { PalmierAgent } from './agent';
import { getSession, type Session } from '../sessions';

/** This session's agent, created on first use against the session's controller. */
export function agentForSession(session: Session): PalmierAgent {
  return (session.agent ??= new PalmierAgent(session.controller));
}

/** Stop only this session's in-flight turn. False when it has no agent or turn. */
export function cancelSessionAgent(session: Session | null | undefined): boolean {
  return session?.agent?.cancel() ?? false;
}

/** True while THIS session's agent has a turn in flight (detach guard, #286/#137). */
export function isSessionAgentBusy(sessionId: string): boolean {
  return getSession(sessionId)?.agent?.isBusy() ?? false;
}
