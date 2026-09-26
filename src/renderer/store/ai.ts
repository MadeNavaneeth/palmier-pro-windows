/**
 * AI store — manages chat state, streaming, and API key configuration.
 */

import { create } from 'zustand';
import { adoptChatSession } from '../../shared/ai/chat-session';
import { normalizePlan, type PlanStep } from '../../shared/editor/plan';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  timestamp: number;
  /**
   * The turn this message ended was stopped by the user (#58).
   *
   * A flag rather than appended text, so the transcript never puts words in the
   * model's mouth. The panel renders it as a tag under the partial answer.
   */
  cancelled?: boolean;
}

export interface ToolCallMessage extends ChatMessage {
  role: 'tool';
  toolName: string;
  toolArgs?: Record<string, unknown>;
  success?: boolean;
}

export interface AiState {
  // Configuration
  isConfigured: boolean;
  /**
   * Selected provider preset id, e.g. `anthropic`, `openai`, `ollama`, `custom`.
   *
   * Was a two-value union before #17/#140; the endpoint and model now live in the
   * main-process config store, keyed by this id.
   */
  providerId: string;
  model: string;
  showSettings: boolean;

  // Chat
  messages: ChatMessage[];
  isStreaming: boolean;
  streamingContent: string;
  /**
   * Working plan for the current request (L3). Session UI state only: it is
   * replaced wholesale by `update_plan`, never persisted, and never a source
   * of truth for what the project contains.
   */
  plan: PlanStep[];

  // Actions
  sendMessage: (content: string) => void;
  /** Stop the turn in progress (#58). Safe to call when nothing is running. */
  cancelStream: () => void;
  clearHistory: () => void;
  setConfigured: (configured: boolean) => void;
  appendStreamToken: (token: string) => void;
  finishStream: (reason?: 'cancelled') => void;
  addToolCall: (name: string, args: Record<string, unknown>) => void;
  addToolResult: (name: string, result: unknown, success: boolean) => void;
  setPlan: (plan: PlanStep[]) => void;
  /**
   * Replace the transcript with an adopted session (upstream #286).
   *
   * A detached chat boots blank and takes over the main-process history; a
   * returning chat replaces its pre-detach transcript with the snapshot so
   * turns taken while detached show up. Anything malformed degrades to an
   * empty chat, never a crash. A session exists only because a provider
   * answered, so adopting a non-empty transcript implies configuration even
   * in a window the user never configured.
   */
  adoptSession: (history: unknown, plan: unknown) => void;
  /**
   * Pull the main-process session and adopt it. True when this window now
   * holds the session; false when there was nothing usable to adopt
   * (transport failure) and the caller should offer a retry instead of a
   * blank chat.
   */
  refreshSession: () => Promise<boolean>;
}

// ─── Store ───────────────────────────────────────────────────────────────────

// Main events do not carry a turn id. After Clear, keep a small fence so the
// cancelled turn's late events cannot be mistaken for the next conversation.
let discardStreamEvents = false;
let turnSequence = 0;
let clearedThroughTurn = 0;
let historyGeneration = 0;

export const useAiStore = create<AiState>((set, get) => ({
  isConfigured: false,
  providerId: 'anthropic',
  model: 'claude-sonnet-4-20250514',
  showSettings: false,

  messages: [],
  isStreaming: false,
  streamingContent: '',
  plan: [],

  // Declared as returning void because callers are UI event handlers that do not
  // await it. The async work is detached explicitly rather than by handing an
  // async function to a void-returning slot, where a rejection would escape into
  // nothing (upstream #89).
  sendMessage: (content: string) => {
    const turnId = ++turnSequence;
    discardStreamEvents = false;
    const userMsg: ChatMessage = { role: 'user', content, timestamp: Date.now() };
    set((s) => ({
      messages: [...s.messages, userMsg],
      isStreaming: true,
      streamingContent: '',
    }));

    void (async () => {
      try {
        // IPC call to main process
        await window.palmier.ai.chat(
          get().messages.map((m) => ({
            role: m.role === 'tool' ? 'assistant' : m.role,
            content: m.content,
          })),
          get().providerId,
        );
      } catch (err: unknown) {
        // A clear can cancel the pending chat and make this rejection arrive
        // after the transcript is already empty. Do not resurrect that turn's
        // error in the fresh conversation.
        if (turnId <= clearedThroughTurn) return;
        // The failure has to land in the transcript: the streaming indicator is
        // on, and without this the panel would spin forever.
        const errorMsg: ChatMessage = {
          role: 'assistant',
          content: `Error: ${err instanceof Error ? err.message : 'Unknown error'}`,
          timestamp: Date.now(),
        };
        set((s) => ({
          messages: [...s.messages, errorMsg],
          isStreaming: false,
        }));
      }
    })();
  },

  // Void-returning for the same reason as sendMessage: the click handler does
  // not await it, so the detachment is explicit (upstream #89).
  cancelStream: () => {
    if (!get().isStreaming) return;
    void window.palmier.ai.cancel().catch(() => {
      // Main answers on a separate channel from the pending chat call, so a
      // failure here means the request could not be delivered at all. The turn
      // ends on its own; the stream-end event still resolves the panel.
    });
  },

  clearHistory: () => {
    // The main handler cancels a busy turn before wiping the authoritative
    // history. Keep this local update in the same user action so a late stream
    // event cannot put the old transcript back on screen.
    discardStreamEvents = true;
    clearedThroughTurn = turnSequence;
    historyGeneration += 1;
    void window.palmier.ai.clearHistory().catch(() => {
      // A failed request is surfaced by the main-process transport; the
      // renderer must still not leave the user staring at a cleared-looking
      // conversation that the UI says is gone.
    });
    set({ messages: [], streamingContent: '', plan: [], isStreaming: false });
  },

  setConfigured: (configured: boolean) => {
    set({ isConfigured: configured });
  },

  appendStreamToken: (token: string) => {
    // Events from a turn cancelled by Clear can arrive after the local reset.
    if (discardStreamEvents) return;
    set((s) => ({ streamingContent: s.streamingContent + token }));
  },

  finishStream: (reason) => {
    // The cancellation event for a cleared turn is not a transcript entry.
    if (discardStreamEvents) {
      discardStreamEvents = false;
      set({ isStreaming: false, streamingContent: '' });
      return;
    }
    const { streamingContent } = get();
    const cancelled = reason === 'cancelled';

    // A cancelled turn still gets a bubble even with nothing streamed, otherwise
    // pressing Stop early looks like the request was never sent.
    if (streamingContent || cancelled) {
      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: streamingContent,
        timestamp: Date.now(),
        ...(cancelled ? { cancelled: true } : {}),
      };
      set((s) => ({
        messages: [...s.messages, assistantMsg],
        isStreaming: false,
        streamingContent: '',
      }));
    } else {
      set({ isStreaming: false });
    }
  },

  addToolCall: (name: string, args: Record<string, unknown>) => {
    if (discardStreamEvents) return;
    const toolMsg: ToolCallMessage = {
      role: 'tool',
      content: JSON.stringify(args, null, 2),
      toolName: name,
      toolArgs: args,
      timestamp: Date.now(),
    };
    set((s) => ({ messages: [...s.messages, toolMsg] }));
  },

  addToolResult: (name: string, result: unknown, success: boolean) => {
    if (discardStreamEvents) return;
    const toolMsg: ToolCallMessage = {
      role: 'tool',
      content: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
      toolName: `${name} → result`,
      success,
      timestamp: Date.now(),
    };
    set((s) => ({ messages: [...s.messages, toolMsg] }));
  },

  setPlan: (plan) => {
    if (discardStreamEvents) return;
    set({ plan });
  },

  adoptSession: (history, plan) => {
    const adopted = adoptChatSession(history, plan);
    const timestamp = Date.now();
    set({
      messages: adopted.messages.map((message) => ({ ...message, timestamp })),
      plan: adopted.plan,
      // Adoption replaces the transcript wholesale; a spinner left over from a
      // previous window's turn must not survive the hand-off.
      isStreaming: false,
      streamingContent: '',
      isConfigured: get().isConfigured || adopted.messages.length > 0,
    });
  },

  refreshSession: () => {
    const generation = historyGeneration;
    return window.palmier.ai
      .getSession()
      .then((response: unknown) => {
        // A snapshot request started before Clear must not repopulate the
        // transcript when its old response arrives after the user emptied it.
        if (generation !== historyGeneration) return true;
        if (typeof response !== 'object' || response === null) return false;
        const { history, plan } = response as { history?: unknown; plan?: unknown };
        get().adoptSession(history, plan);
        return true;
      })
      .catch(() => false);
  },
}));

// ─── Subscribe to streaming events from main process ─────────────────────────

export function initAiListeners(): () => void {
  const unsubs: Array<() => void> = [];

  unsubs.push(
    window.palmier.on('ai:stream-token', (token: unknown) => {
      useAiStore.getState().appendStreamToken(token as string);
    }),
  );

  unsubs.push(
    window.palmier.on('ai:stream-end', (reason: unknown) => {
      useAiStore.getState().finishStream(reason === 'cancelled' ? 'cancelled' : undefined);
    }),
  );

  unsubs.push(
    window.palmier.on('ai:tool-call', (payload: unknown) => {
      // Narrowed like ai:plan below: the renderer is not the only writer of
      // this state, and a malformed payload must not append a blank receipt.
      if (typeof payload !== 'object' || payload === null) return;
      const { name, args } = payload as { name?: unknown; args?: unknown };
      if (typeof name !== 'string') return;
      if (typeof args !== 'object' || args === null || Array.isArray(args)) return;
      useAiStore.getState().addToolCall(name, args as Record<string, unknown>);
    }),
  );

  unsubs.push(
    window.palmier.on('ai:tool-result', (payload: unknown) => {
      if (typeof payload !== 'object' || payload === null) return;
      const { name, result } = payload as { name?: unknown; result?: unknown };
      if (typeof name !== 'string') return;
      const success =
        typeof result === 'object' && result !== null && 'success' in result
          ? (result as { success?: unknown }).success !== false
          : true;
      useAiStore.getState().addToolResult(name, result, success);
    }),
  );

  unsubs.push(
    window.palmier.on('ai:plan', (plan: unknown) => {
      // Narrow again here: the renderer is not the only writer of this state
      // and a malformed payload must not produce two active steps.
      useAiStore.getState().setPlan(normalizePlan(plan));
    }),
  );

  return () => unsubs.forEach((fn) => fn());
}
