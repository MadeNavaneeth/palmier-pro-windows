/**
 * ChatPanel — the AI assistant chat interface.
 * Shows message history, streaming responses, tool call visualization,
 * and an input for sending messages.
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useAiStore, type ChatMessage, type ToolCallMessage } from '../../store/ai';

export function ChatPanel() {
  const {
    messages,
    isStreaming,
    isConfigured,
    sendMessage,
    clearHistory,
  } = useAiStore();

  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;
    sendMessage(trimmed);
    setInput('');
  }, [input, isStreaming, sendMessage]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  if (!isConfigured) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
        <div className="text-3xl mb-3">🤖</div>
        <h3 className="text-sm font-medium text-text-primary mb-1">AI Assistant</h3>
        <p className="text-2xs text-text-muted mb-4 max-w-[200px]">
          Set up your API key to use the AI agent. It can read and edit your timeline directly.
        </p>
        <button
          onClick={() => useAiStore.setState({ showSettings: true })}
          className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white transition hover:bg-accent-hover"
        >
          Configure API Key
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-surface-3 px-3 py-2">
        <h2 className="text-xs font-medium text-text-secondary uppercase tracking-wide">
          AI Agent
        </h2>
        <div className="flex items-center gap-1">
          <button
            onClick={clearHistory}
            className="rounded px-1.5 py-0.5 text-2xs text-text-muted transition hover:bg-surface-3 hover:text-text-primary"
            title="Clear conversation"
          >
            Clear
          </button>
          <button
            onClick={() => useAiStore.setState({ showSettings: true })}
            className="rounded px-1.5 py-0.5 text-2xs text-text-muted transition hover:bg-surface-3 hover:text-text-primary"
            title="Settings"
          >
            ⚙
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.length === 0 && (
          <div className="text-center py-8">
            <p className="text-2xs text-text-muted">
              Ask the AI to edit your timeline, add clips, trim, split, or generate media.
            </p>
          </div>
        )}

        {messages.map((msg, i) => (
          <MessageBubble key={i} message={msg} />
        ))}

        {isStreaming && (
          <div className="flex items-center gap-2 px-3 py-2">
            <div className="flex gap-1">
              <div className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
              <div className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse [animation-delay:150ms]" />
              <div className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse [animation-delay:300ms]" />
            </div>
            <span className="text-2xs text-text-muted">Thinking...</span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-surface-3 p-3">
        <div className="flex gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask the AI to edit your project..."
            rows={1}
            className="flex-1 resize-none rounded border border-surface-3 bg-surface-2 px-3 py-2 text-xs text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
            disabled={isStreaming}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isStreaming}
            className="rounded bg-accent px-3 py-2 text-xs font-medium text-white transition hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Message Bubble ──────────────────────────────────────────────────────────

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg bg-accent/20 border border-accent/30 px-3 py-2">
          <p className="text-xs text-text-primary whitespace-pre-wrap">{message.content}</p>
        </div>
      </div>
    );
  }

  if (message.role === 'tool') {
    const toolMsg = message as ToolCallMessage;
    return (
      <div className="px-2">
        <div className="rounded border border-surface-3 bg-surface-2/50 px-3 py-2">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-2xs font-mono text-amber-400">⚡ {toolMsg.toolName}</span>
            {toolMsg.success !== undefined && (
              <span className={`text-2xs ${toolMsg.success ? 'text-emerald-400' : 'text-red-400'}`}>
                {toolMsg.success ? '✓' : '✗'}
              </span>
            )}
          </div>
          {toolMsg.content && (
            <pre className="text-2xs text-text-muted font-mono whitespace-pre-wrap overflow-hidden max-h-24">
              {toolMsg.content.length > 200 ? toolMsg.content.slice(0, 200) + '...' : toolMsg.content}
            </pre>
          )}
        </div>
      </div>
    );
  }

  // Assistant message
  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] rounded-lg bg-surface-2 border border-surface-3 px-3 py-2">
        <p className="text-xs text-text-primary whitespace-pre-wrap">{message.content}</p>
      </div>
    </div>
  );
}
