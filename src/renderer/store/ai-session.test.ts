/**
 * Regression coverage for the chat session hand-off (upstream #286).
 *
 * A detached chat adopts the main-process session on boot, and the returning
 * chat pulls it again — both through the same two store actions. These tests
 * pin the parts that are easy to get subtly wrong: adoption replaces the
 * transcript wholesale (no merge, no leftover spinner), malformed payloads
 * degrade to an empty chat, a failed pull reports false so the window can
 * offer a retry, and the streaming flag the detach gate reads tracks a real
 * turn lifecycle.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/** window.palmier stand-in; the store only touches ai + on. */
function installAi(stubs: {
  getSession?: () => Promise<unknown>;
  chat?: () => Promise<void>;
  on?: (channel: string, callback: (...args: unknown[]) => void) => () => void;
} = {}): Record<string, (...args: unknown[]) => void> {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  vi.stubGlobal('window', {
    palmier: {
      ai: {
        getSession: stubs.getSession ?? (() => Promise.reject(new Error('down'))),
        chat: stubs.chat ?? (() => new Promise<void>(() => {})),
        cancel: () => Promise.resolve({ cancelled: true }),
      },
      on:
        stubs.on ??
        ((channel: string, callback: (...args: unknown[]) => void) => {
          handlers[channel] = callback;
          return () => {};
        }),
    },
  });
  return handlers;
}

/** Fresh module instance per test. */
async function loadStore() {
  vi.resetModules();
  const module = await import('./ai');
  return module.useAiStore;
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const HISTORY = [
  { role: 'user', content: 'Trim the intro' },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Checking.' },
      { type: 'tool_use', id: 't1', name: 'get_timeline', input: {} },
    ],
  },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
  { role: 'assistant', content: 'Three clips.' },
];

describe('adoptSession', () => {
  it('replaces the transcript and clears streaming state', async () => {
    installAi();
    const useAiStore = await loadStore();

    useAiStore.setState({
      messages: [{ role: 'user', content: 'stale', timestamp: 1 }],
      isStreaming: true,
      streamingContent: 'partial',
    });
    useAiStore.getState().adoptSession(HISTORY, []);

    const state = useAiStore.getState();
    expect(state.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'assistant',
    ]);
    expect(state.messages.every((message) => typeof message.timestamp === 'number')).toBe(true);
    expect(state.isStreaming).toBe(false);
    expect(state.streamingContent).toBe('');
  });

  it('implies configuration when the adopted transcript is non-empty', async () => {
    installAi();
    const useAiStore = await loadStore();

    expect(useAiStore.getState().isConfigured).toBe(false);
    useAiStore.getState().adoptSession(HISTORY, []);
    expect(useAiStore.getState().isConfigured).toBe(true);
  });

  it('degrades malformed payloads to an empty chat', async () => {
    installAi();
    const useAiStore = await loadStore();

    useAiStore.getState().adoptSession('history', { steps: 'nope' });

    expect(useAiStore.getState().messages).toEqual([]);
    expect(useAiStore.getState().plan).toEqual([]);
    expect(useAiStore.getState().isStreaming).toBe(false);
  });
});

describe('refreshSession', () => {
  it('adopts a well-formed session and reports true', async () => {
    installAi({
      getSession: () =>
        Promise.resolve({
          history: HISTORY,
          plan: [{ step: 'Trim the intro', status: 'completed' }],
        }),
    });
    const useAiStore = await loadStore();

    await expect(useAiStore.getState().refreshSession()).resolves.toBe(true);
    expect(useAiStore.getState().messages).toHaveLength(5);
    expect(useAiStore.getState().plan).toEqual([
      { step: 'Trim the intro', status: 'completed' },
    ]);
  });

  it('reports false and keeps state when the call fails', async () => {
    installAi({ getSession: () => Promise.reject(new Error('down')) });
    const useAiStore = await loadStore();

    useAiStore.setState({
      messages: [{ role: 'user', content: 'kept', timestamp: 1 }],
    });
    await expect(useAiStore.getState().refreshSession()).resolves.toBe(false);
    expect(useAiStore.getState().messages).toEqual([
      { role: 'user', content: 'kept', timestamp: 1 },
    ]);
  });

  it('reports false on a malformed envelope', async () => {
    installAi({ getSession: () => Promise.resolve(42) });
    const useAiStore = await loadStore();

    await expect(useAiStore.getState().refreshSession()).resolves.toBe(false);
    expect(useAiStore.getState().messages).toEqual([]);
  });
});

describe('tool receipt listeners', () => {
  it('appends live call and result receipts, narrowing payloads', async () => {
    const handlers = installAi();
    const module = await import('./ai');
    const useAiStore = module.useAiStore;

    module.initAiListeners();
    handlers['ai:tool-call']?.({ name: 'get_timeline', args: { detail: 'full' } });
    handlers['ai:tool-call']?.('nope');
    handlers['ai:tool-call']?.({ name: 'get_timeline', args: ['not', 'a', 'record'] });
    handlers['ai:tool-result']?.({
      name: 'get_timeline',
      result: { success: true, data: { clips: 3 } },
    });
    handlers['ai:tool-result']?.({ name: 'get_timeline', result: { success: false } });
    handlers['ai:tool-result']?.(null);

    const messages = useAiStore.getState().messages;
    expect(messages.map((message) => message.role)).toEqual(['tool', 'tool', 'tool']);
    expect(messages[0].content).toBe(JSON.stringify({ detail: 'full' }, null, 2));
    expect((messages[1] as { success?: boolean }).success).toBe(true);
    expect((messages[2] as { success?: boolean }).success).toBe(false);
  });
});

describe('streaming state', () => {
  it('tracks a turn lifecycle for the detach gate', async () => {
    const handlers = installAi();
    const module = await import('./ai');
    const useAiStore = module.useAiStore;

    // A pending chat call keeps the turn open, like a real streaming turn.
    useAiStore.getState().sendMessage('hi');
    expect(useAiStore.getState().isStreaming).toBe(true);

    module.initAiListeners();
    handlers['ai:stream-end']?.();
    expect(useAiStore.getState().isStreaming).toBe(false);
  });
});
