/**
 * AI store — manages chat state, streaming, and API key configuration.
 */

import { create } from 'zustand';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  timestamp: number;
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
  provider: 'anthropic' | 'openai';
  model: string;
  showSettings: boolean;

  // Chat
  messages: ChatMessage[];
  isStreaming: boolean;
  streamingContent: string;

  // Actions
  sendMessage: (content: string) => void;
  clearHistory: () => void;
  setConfigured: (configured: boolean) => void;
  appendStreamToken: (token: string) => void;
  finishStream: () => void;
  addToolCall: (name: string, args: Record<string, unknown>) => void;
  addToolResult: (name: string, result: unknown, success: boolean) => void;
}

// ─── Store ───────────────────────────────────────────────────────────────────

export const useAiStore = create<AiState>((set, get) => ({
  isConfigured: false,
  provider: 'anthropic',
  model: 'claude-sonnet-4-20250514',
  showSettings: false,

  messages: [],
  isStreaming: false,
  streamingContent: '',

  sendMessage: async (content: string) => {
    const userMsg: ChatMessage = { role: 'user', content, timestamp: Date.now() };
    set((s) => ({
      messages: [...s.messages, userMsg],
      isStreaming: true,
      streamingContent: '',
    }));

    try {
      // IPC call to main process
      await window.palmier.ai.chat(
        get().messages.map((m) => ({ role: m.role === 'tool' ? 'assistant' : m.role, content: m.content })),
        get().provider,
      );
    } catch (err: any) {
      const errorMsg: ChatMessage = {
        role: 'assistant',
        content: `Error: ${err.message || 'Unknown error'}`,
        timestamp: Date.now(),
      };
      set((s) => ({
        messages: [...s.messages, errorMsg],
        isStreaming: false,
      }));
    }
  },

  clearHistory: () => {
    set({ messages: [], streamingContent: '' });
  },

  setConfigured: (configured: boolean) => {
    set({ isConfigured: configured });
  },

  appendStreamToken: (token: string) => {
    set((s) => ({ streamingContent: s.streamingContent + token }));
  },

  finishStream: () => {
    const { streamingContent } = get();
    if (streamingContent) {
      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: streamingContent,
        timestamp: Date.now(),
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
    window.palmier.on('ai:stream-end', () => {
      useAiStore.getState().finishStream();
    }),
  );

  return () => unsubs.forEach((fn) => fn());
}
