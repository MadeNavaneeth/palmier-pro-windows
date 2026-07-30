/**
 * AI store — manages chat state, streaming, and API key configuration.
 */

import { create } from 'zustand';

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
}

// ─── Store ───────────────────────────────────────────────────────────────────

export const useAiStore = create<AiState>((set, get) => ({
  isConfigured: false,
  providerId: 'anthropic',
  model: 'claude-sonnet-4-20250514',
  showSettings: false,

  messages: [],
  isStreaming: false,
  streamingContent: '',

  // Declared as returning void because callers are UI event handlers that do not
  // await it. The async work is detached explicitly rather than by handing an
  // async function to a void-returning slot, where a rejection would escape into
  // nothing (upstream #89).
  sendMessage: (content: string) => {
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
    // Stop first: a turn still running would stream its answer into a transcript
    // the user just emptied.
    get().cancelStream();
    set({ messages: [], streamingContent: '' });
  },

  setConfigured: (configured: boolean) => {
    set({ isConfigured: configured });
  },

  appendStreamToken: (token: string) => {
    set((s) => ({ streamingContent: s.streamingContent + token }));
  },

  finishStream: (reason) => {
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
    const toolMsg: ToolCallMessage = {
      role: 'tool',
      content: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
      toolName: `${name} → result`,
      success,
      timestamp: Date.now(),
    };
    set((s) => ({ messages: [...s.messages, toolMsg] }));
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

  return () => unsubs.forEach((fn) => fn());
}
