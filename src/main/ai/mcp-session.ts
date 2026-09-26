/**
 * Session targeting for the loopback HTTP MCP endpoint (#137, Slice 2).
 *
 * The transport stays one process-wide listener — token and port are shared —
 * and only the editor a request's tools act on is resolved per request:
 *
 * - `X-Palmier-Session: <id>` targets that session exactly. An unknown id is
 *   refused upstream (404 in mcp-http.ts) rather than silently falling back:
 *   running edits against the wrong workspace is worse than failing.
 * - No header targets the active session — the most recently focused main
 *   window, falling back to the first live session (sessions.ts).
 * - Windowless `--mcp-server` mode passes no resolver at all and keeps its
 *   fixed controller; that path never touches this module.
 */

import { getActiveSession, getSession } from '../sessions';
import type { EditorController } from '../../shared/editor/controller';

/** Resolve the controller an MCP request should act on; null means "refuse". */
export function resolveMcpController(sessionId: string | null): EditorController | null {
  const session = sessionId === null ? getActiveSession() : getSession(sessionId);
  return session?.controller ?? null;
}
