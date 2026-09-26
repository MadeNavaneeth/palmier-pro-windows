/**
 * MCP session targeting (upstream #137, Slice 2): which editor a loopback
 * request's tools act on — an explicit `X-Palmier-Session` id, the active
 * session by default, and null (fixed-controller fallback) for windowless
 * mode. Transport-level coverage of the same contract lives in
 * mcp-http.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveMcpController } from './mcp-session';
import { createSession, markSessionActive, resetSessions } from '../sessions';

beforeEach(() => resetSessions());
afterEach(() => resetSessions());

describe('resolveMcpController (#137 Slice 2)', () => {
  it('targets exactly the session the id names', () => {
    const a = createSession();
    const b = createSession();

    expect(resolveMcpController(a.id)).toBe(a.controller);
    expect(resolveMcpController(b.id)).toBe(b.controller);
    expect(a.controller).not.toBe(b.controller);
  });

  it('refuses an unknown id instead of falling back', () => {
    createSession();
    expect(resolveMcpController('not-a-session')).toBeNull();
  });

  it('defaults to the active session when no id is given', () => {
    const a = createSession();
    const b = createSession(); // minting marks the new session active
    expect(resolveMcpController(null)).toBe(b.controller);

    markSessionActive(a.id);
    expect(resolveMcpController(null)).toBe(a.controller);
  });

  it('returns null with no sessions — windowless mode keeps its fixed controller', () => {
    expect(resolveMcpController(null)).toBeNull();
    expect(resolveMcpController('any-session')).toBeNull();
  });
});
