import { describe, expect, it, beforeAll, beforeEach, afterEach, vi } from 'vitest';

const sdkMocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: sdkMocks.create };
  },
}));

const electronMocks = vi.hoisted(() => {
  const send = vi.fn();
  return {
    handlers: new Map<string, (event: { sender: { id: number } }, ...args: unknown[]) => unknown>(),
    app: {
      getPath: vi.fn(() => 'C:\\palmier-test'),
    },
    safeStorage: {
      isEncryptionAvailable: vi.fn(() => false),
      encryptString: vi.fn((value: string) => Buffer.from(value)),
      decryptString: vi.fn((value: Buffer) => value.toString()),
    },
    BrowserWindow: {
      fromWebContents: vi.fn(() => ({ webContents: { send } })),
    },
  };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (event: { sender: { id: number } }, ...args: unknown[]) => unknown) => {
      electronMocks.handlers.set(channel, handler);
    }),
  },
  app: electronMocks.app,
  safeStorage: electronMocks.safeStorage,
  BrowserWindow: electronMocks.BrowserWindow,
}));

vi.mock('electron-store', () => {
  class Store {
    private readonly values = new Map<string, unknown>();

    get(key: string): unknown {
      return this.values.get(key);
    }

    set(key: string, value: unknown): void {
      this.values.set(key, value);
    }

    delete(key: string): void {
      this.values.delete(key);
    }
  }
  return { default: Store };
});

import { registerAiHandlers } from './ipc';
import { createSession, NO_SESSION_ERROR, resetSessions, type Session } from '../sessions';
import { agentForSession } from './session-agent';
import type { PalmierAgent, StreamCallbacks } from './agent';

const senderA = { id: 101 };
const senderB = { id: 202 };
let sessionA: Session;
let sessionB: Session;
let agentA: ReturnType<typeof makeAgent>;
let agentB: ReturnType<typeof makeAgent>;
const sessionsBySender = new Map<number, Session>();

function makeAgent(historyText: string) {
  let history: Array<{ role: string; content: string }> = [{ role: 'user', content: historyText }];
  const order: string[] = [];
  const cancel = vi.fn(() => {
    order.push('cancel');
    return true;
  });
  const clearHistory = vi.fn(() => {
    order.push('clear');
    history = [];
  });
  const agent = {
    cancel,
    clearHistory,
    getSessionSnapshot: vi.fn(() => ({
      history: history.map((entry) => ({ ...entry })),
      plan: null,
    })),
    isBusy: vi.fn(() => true),
  } as unknown as PalmierAgent;
  return {
    agent,
    order,
    cancel,
    clearHistory,
    snapshot: () => agent.getSessionSnapshot(),
  };
}

function invoke(channel: string, sender: { id: number }, ...args: unknown[]): unknown {
  const handler = electronMocks.handlers.get(channel);
  if (!handler) throw new Error(`Missing handler: ${channel}`);
  return handler({ sender }, ...args);
}

function silentCallbacks(): StreamCallbacks {
  return {
    onToken: () => {},
    onToolCall: () => {},
    onToolResult: () => {},
    onPlan: () => {},
    onComplete: () => {},
    onCancelled: () => {},
    onError: (error) => { throw new Error(error); },
  };
}

beforeAll(() => {
  registerAiHandlers((sender) => sessionsBySender.get(sender.id) ?? null);
});

beforeEach(() => {
  sdkMocks.create.mockReset();
  resetSessions();
  sessionsBySender.clear();
  sessionA = createSession();
  sessionB = createSession();
  agentA = makeAgent('A private turn');
  agentB = makeAgent('B private turn');
  sessionA.agent = agentA.agent;
  sessionB.agent = agentB.agent;
  sessionsBySender.set(senderA.id, sessionA);
  sessionsBySender.set(senderB.id, sessionB);
});

afterEach(() => {
  resetSessions();
  sessionsBySender.clear();
});

describe('ai:clear-history', () => {
  it('clears the requesting session and leaves another session intact', async () => {
    await expect(Promise.resolve(invoke('ai:clear-history', senderA))).resolves.toEqual({
      success: true,
      cancelled: true,
    });

    expect(agentA.clearHistory).toHaveBeenCalledTimes(1);
    expect(agentB.clearHistory).not.toHaveBeenCalled();
    expect(agentA.snapshot()).toEqual({ history: [], plan: null });
    expect(agentB.snapshot()).toEqual({
      history: [{ role: 'user', content: 'B private turn' }],
      plan: null,
    });
  });

  it('clears the real PalmierAgent history through the handler', async () => {
    sessionA.agent = undefined;
    const agent = agentForSession(sessionA);
    agent.configure({ provider: 'anthropic', apiKey: 'sk-test', model: 'claude-test' });
    sdkMocks.create.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Private answer.' }],
      stop_reason: 'end_turn',
    });
    await agent.chat('private question', silentCallbacks());
    expect(JSON.stringify(agent.getSessionSnapshot())).toContain('private question');

    await expect(Promise.resolve(invoke('ai:clear-history', senderA))).resolves.toEqual({
      success: true,
      cancelled: false,
    });
    expect(agent.getSessionSnapshot()).toEqual({ history: [], plan: null });
  });

  it('cancels a busy session before clearing it', async () => {
    await Promise.resolve(invoke('ai:clear-history', senderA));

    expect(agentA.order).toEqual(['cancel', 'clear']);
  });

  it('returns an empty session snapshot for a detached chat boot after clear', async () => {
    await invoke('ai:clear-history', senderA);

    await expect(Promise.resolve(invoke('ai:get-session', senderA))).resolves.toEqual({
      history: [],
      plan: null,
    });
  });

  it('waits for a busy chat before the final clear and blocks detached reads', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let history: Array<{ role: string; content: string }> = [];
    const cancel = vi.fn(() => true);
    const clearHistory = vi.fn(() => {
      history = [];
    });
    const agent = {
      configure: vi.fn(),
      cancel,
      clearHistory,
      chat: vi.fn(async () => {
        await hold;
        history.push({ role: 'assistant', content: 'late result' });
      }),
      getSessionSnapshot: vi.fn(() => ({ history: [...history], plan: null })),
    } as unknown as PalmierAgent;
    sessionA.agent = agent;

    const chat = invoke('ai:chat', senderA, [{ role: 'user', content: 'go' }], 'ollama');
    await Promise.resolve();
    const clear = invoke('ai:clear-history', senderA);
    const snapshot = invoke('ai:get-session', senderA);
    let clearSettled = false;
    let snapshotSettled = false;
    void Promise.resolve(clear).then(() => {
      clearSettled = true;
    });
    void Promise.resolve(snapshot).then(() => {
      snapshotSettled = true;
    });
    await Promise.resolve();
    expect(clearSettled).toBe(false);
    expect(snapshotSettled).toBe(false);

    release();
    await expect(Promise.resolve(chat)).resolves.toBeUndefined();
    await expect(Promise.resolve(clear)).resolves.toEqual({ success: true, cancelled: true });
    await expect(Promise.resolve(snapshot)).resolves.toEqual({ history: [], plan: null });
    expect(clearHistory).toHaveBeenCalledTimes(1);
    expect(history).toEqual([]);
  });

  it('refuses a sender that has no session', async () => {
    await expect(Promise.resolve(invoke('ai:clear-history', { id: 999 }))).rejects.toThrow(
      NO_SESSION_ERROR,
    );
  });
});
