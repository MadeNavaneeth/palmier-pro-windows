import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, Check, Send, Settings, Trash2, Wrench, X } from 'lucide-react';
import { useAiStore, type ChatMessage, type ToolCallMessage } from '../../store/ai';

export function ChatPanel() {
  const { messages, isStreaming, isConfigured, sendMessage, clearHistory } = useAiStore();
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

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
    (event: React.KeyboardEvent) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  if (!isConfigured) {
    return (
      <div className="flex flex-1 flex-col">
        <PanelHeader onClear={clearHistory} />
        <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
          <Bot size={26} strokeWidth={1.4} className="mb-3 text-text-muted" />
          <h3 className="mb-1 text-[12px] font-medium text-text-primary">Agent</h3>
          <p className="mb-4 max-w-[210px] text-[10px] leading-4 text-text-muted">
            Connect a provider to edit the active timeline with Palmier Agent.
          </p>
          <button
            onClick={() => useAiStore.setState({ showSettings: true })}
            className="rounded-md bg-accent px-3 py-1.5 text-[11px] font-medium text-surface-0 hover:bg-accent-hover"
          >
            Configure Agent
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader onClear={clearHistory} />

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {messages.length === 0 && (
          <div className="py-8 text-center">
            <p className="text-[10px] leading-4 text-text-muted">
              Ask the agent to inspect or edit the active timeline.
            </p>
          </div>
        )}

        {messages.map((message, index) => (
          <MessageBubble key={index} message={message} />
        ))}

        {isStreaming && (
          <div className="flex items-center gap-2 px-2 py-2">
            <div className="flex gap-1">
              <div className="h-1 w-1 animate-pulse rounded-full bg-accent" />
              <div className="h-1 w-1 animate-pulse rounded-full bg-accent [animation-delay:150ms]" />
              <div className="h-1 w-1 animate-pulse rounded-full bg-accent [animation-delay:300ms]" />
            </div>
            <span className="text-[10px] text-text-muted">Thinking...</span>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="border-t border-white/10 p-2">
        <div className="flex items-end gap-1.5 rounded-md border border-white/12 bg-surface-2 p-1.5 focus-within:border-white/30">
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask Palmier Agent..."
            rows={2}
            className="min-w-0 flex-1 resize-none bg-transparent px-1.5 py-1 text-[11px] leading-4 text-text-primary outline-none placeholder:text-text-muted"
            disabled={isStreaming}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isStreaming}
            className="flex h-7 w-7 items-center justify-center rounded-md bg-accent text-surface-0 hover:bg-accent-hover disabled:opacity-30"
            title="Send"
            aria-label="Send message"
          >
            <Send size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}

function PanelHeader({ onClear }: { onClear: () => void }) {
  return (
    <div className="panel-header flex items-center justify-between px-2">
      <span className="text-[11px] font-medium text-text-secondary">Agent</span>
      <div className="flex items-center gap-0.5">
        <button
          onClick={onClear}
          className="icon-button"
          title="Clear conversation"
          aria-label="Clear conversation"
        >
          <Trash2 size={13} />
        </button>
        <button
          onClick={() => useAiStore.setState({ showSettings: true })}
          className="icon-button"
          title="Agent settings"
          aria-label="Agent settings"
        >
          <Settings size={13} />
        </button>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[88%] rounded-md border border-white/12 bg-surface-3 px-2.5 py-2">
          <p className="whitespace-pre-wrap text-[11px] leading-4 text-text-primary">
            {message.content}
          </p>
        </div>
      </div>
    );
  }

  if (message.role === 'tool') {
    const toolMessage = message as ToolCallMessage;
    return (
      <div className="rounded-md border border-white/10 bg-surface-2/70 px-2.5 py-2">
        <div className="mb-1 flex items-center gap-1.5">
          <Wrench size={11} className="text-timecode" />
          <span className="font-mono text-[9px] text-timecode">{toolMessage.toolName}</span>
          {toolMessage.success !== undefined && (
            <span className={toolMessage.success ? 'text-emerald-400' : 'text-red-400'}>
              {toolMessage.success ? <Check size={11} /> : <X size={11} />}
            </span>
          )}
        </div>
        {toolMessage.content && (
          <pre className="max-h-24 overflow-hidden whitespace-pre-wrap font-mono text-[9px] leading-4 text-text-muted">
            {toolMessage.content.length > 200
              ? `${toolMessage.content.slice(0, 200)}...`
              : toolMessage.content}
          </pre>
        )}
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div className="max-w-[92%] px-1 py-1">
        <p className="whitespace-pre-wrap text-[11px] leading-4 text-text-secondary">
          {message.content}
        </p>
      </div>
    </div>
  );
}
