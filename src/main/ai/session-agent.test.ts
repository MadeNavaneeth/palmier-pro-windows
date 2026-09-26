/**
 * Per-session PalmierAgent registry (upstream #137, Slice 2).
 *
 * Two workspaces must chat concurrently without sharing history, busy state,
 * or cancel: each session lazily owns its own agent against its own
 * controller, busy and cancel scope to one session, and closing a window
 * disposes that session's turn so nothing keeps running orphaned.
 *
 * Provider calls are mocked at the Anthropic SDK, same seam as
 * agent.session.test.ts — the registry delegates turn mechanics to
 * PalmierAgent itself, which has its own coverage.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: (params: unknown, options?: unknown) => mocks.create(params, options),
    };
  },
}));

import { agentForSession, cancelSessionAgent, isSessionAgentBusy } from './session-agent';
import { createSession, removeSession, resetSessions } from '../sessions';
import type { PalmierAgent, StreamCallbacks } from './agent';

const CONFIG = { provider: 'anthropic' as const, apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' };

beforeEach(() => {
  resetSessions();
  mocks.create.mockReset();
});
afterEach(() => resetSessions());

function textTurn(text: string) {
  return { content: [{ type: 'text', text }], stop_reason: 'end_turn' };
}

/** Callbacks that stay silent unless something unexpected happens. */
function callbacks(): StreamCallbacks {
  return {
    onToken: () => {},
    onToolCall: () => {},
    onToolResult: () => {},
    onPlan: () => {},
    onComplete: () => {},
    onError: (error) => { throw new Error(`unexpected agent error: ${error}`); },
    onCancelled: () => {},
  };
}

/** Minimal stand-in for the two members the registry delegates to. */
function stubAgent(overrides: { cancel?: () => boolean; isBusy?: () => boolean } = {}): PalmierAgent {
  return {
    cancel: overrides.cancel ?? (() => true),
    isBusy: overrides.isBusy ?? (() => false),
  } as unknown as PalmierAgent;
}

describe('per-session agent registry (#137 Slice 2)', () => {
  it('gives each session its own agent, created once per session', () => {
    const a = createSession();
    const b = createSession();

    const agentA = agentForSession(a);
    const agentB = agentForSession(b);

    expect(agentA).not.toBe(agentB);
    // The session owns its agent, so window teardown can dispose it.
    expect(a.agent).toBe(agentA);
    expect(b.agent).toBe(agentB);
    // One agent per session, not one per chat call.
    expect(agentForSession(a)).toBe(agentA);
  });

  it('runs turns in two sessions concurrently with per-session busy state', async () => {
    const a = createSession();
    const b = createSession();
    agentForSession(a).configure(CONFIG);
    agentForSession(b).configure(CONFIG);

    // A's provider never answers, so A's turn stays in flight for the checks.
    mocks.create.mockImplementation(() => new Promise(() => {}));
    void agentForSession(a).chat('hello from A', callbacks());
    expect(isSessionAgentBusy(a.id)).toBe(true);
    expect(isSessionAgentBusy(b.id)).toBe(false);

    // One session still refuses its own second concurrent turn…
    const refusals: string[] = [];
    await agentForSession(a).chat('again', {
      ...callbacks(),
      onError: (error) => { refusals.push(error); },
    });
    expect(refusals.join(' ')).toContain('already running');

    // …while the other session runs its own turn at the same time.
    void agentForSession(b).chat('hello from B', callbacks());
    expect(isSessionAgentBusy(b.id)).toBe(true);
    expect(isSessionAgentBusy(a.id)).toBe(true);
  });

  it('keeps each session’s history separate', async () => {
    const a = createSession();
    const b = createSession();
    const agentA = agentForSession(a);
    const agentB = agentForSession(b);
    agentA.configure(CONFIG);
    agentB.configure(CONFIG);

    mocks.create.mockResolvedValueOnce(textTurn('Done in A.'));
    await agentA.chat('remember this for A only', callbacks());

    expect(JSON.stringify(agentA.getSessionSnapshot())).toContain('remember this for A only');
    expect(agentB.getSessionSnapshot()).toEqual({ history: [], plan: null });
  });

  it('cancels only the named session’s agent', () => {
    const a = createSession();
    const b = createSession();
    const cancelA = vi.fn(() => true);
    a.agent = stubAgent({ cancel: cancelA });
    const cancelB = vi.fn(() => true);
    b.agent = stubAgent({ cancel: cancelB });

    expect(cancelSessionAgent(a)).toBe(true);
    expect(cancelA).toHaveBeenCalledTimes(1);
    expect(cancelB).not.toHaveBeenCalled();

    // A session that never chatted — or a sender with no session at all —
    // has nothing to stop, and says so instead of pretending.
    const bare = createSession();
    expect(cancelSessionAgent(bare)).toBe(false);
    expect(cancelSessionAgent(null)).toBe(false);
  });

  it('disposes the agent turn when the session is removed', () => {
    const session = createSession();
    const cancel = vi.fn(() => true);
    session.agent = stubAgent({ cancel });

    removeSession(session.id);

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(isSessionAgentBusy(session.id)).toBe(false);
    expect(isSessionAgentBusy('no-such-session')).toBe(false);
  });
});
