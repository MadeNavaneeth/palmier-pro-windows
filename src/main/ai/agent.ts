/**
 * In-app AI Agent — BYOK (bring your own key) chat with tool use.
 * Uses @anthropic-ai/sdk for Claude, with a provider-agnostic interface
 * so other models (OpenAI, local) can be added later.
 *
 * The agent calls the same ToolExecutor the MCP server uses,
 * ensuring identical behavior whether driven locally or externally.
 */

import Anthropic from '@anthropic-ai/sdk';
import { tools, toolsToJsonSchema } from './tools';
import { ToolExecutor } from './executor';
import type { EditorController } from '../../shared/editor/controller';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentConfig {
  provider: 'anthropic' | 'openai';
  apiKey: string;
  model?: string;
  maxTokens?: number;
}

export interface StreamCallbacks {
  onToken: (token: string) => void;
  onToolCall: (name: string, args: Record<string, unknown>) => void;
  onToolResult: (name: string, result: unknown) => void;
  onComplete: (fullResponse: string) => void;
  onError: (error: string) => void;
}

// ─── Agent ───────────────────────────────────────────────────────────────────

export class PalmierAgent {
  private executor: ToolExecutor;
  private config: AgentConfig | null = null;
  private conversationHistory: any[] = [];

  constructor(editor: EditorController) {
    this.executor = new ToolExecutor(editor);
  }

  configure(config: AgentConfig): void {
    this.config = config;
  }

  isConfigured(): boolean {
    return this.config !== null && this.config.apiKey.length > 0;
  }

  clearHistory(): void {
    this.conversationHistory = [];
  }

  async chat(userMessage: string, callbacks: StreamCallbacks): Promise<void> {
    if (!this.config) {
      callbacks.onError('Agent not configured. Set an API key first.');
      return;
    }

    if (this.config.provider === 'anthropic') {
      await this.chatAnthropic(userMessage, callbacks);
    } else {
      callbacks.onError(`Provider "${this.config.provider}" not yet supported.`);
    }
  }

  private async chatAnthropic(userMessage: string, callbacks: StreamCallbacks): Promise<void> {
    const client = new Anthropic({ apiKey: this.config!.apiKey });
    const model = this.config!.model || 'claude-sonnet-4-20250514';
    const maxTokens = this.config!.maxTokens || 4096;

    // Add user message to history
    this.conversationHistory.push({ role: 'user', content: userMessage });

    // Convert our tool schemas to Anthropic format
    const anthropicTools = Object.values(tools).map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: {
        type: 'object' as const,
        ...toolsToJsonSchema().find((t) => t.name === tool.name)?.inputSchema as Record<string, unknown>,
      },
    }));

    try {
      let fullResponse = '';
      let continueLoop = true;

      while (continueLoop) {
        const response = await client.messages.create({
          model,
          max_tokens: maxTokens,
          system: SYSTEM_PROMPT,
          messages: this.conversationHistory,
          tools: anthropicTools,
        });

        // Process content blocks
        const assistantContent: any[] = [];

        for (const block of response.content) {
          if (block.type === 'text') {
            fullResponse += block.text;
            callbacks.onToken(block.text);
            assistantContent.push(block);
          } else if (block.type === 'tool_use') {
            assistantContent.push(block);
            callbacks.onToolCall(block.name, block.input as Record<string, unknown>);

            // Execute the tool
            const result = await this.executor.execute(block.name, block.input as Record<string, unknown>);
            callbacks.onToolResult(block.name, result);

            // Add tool result to conversation
            this.conversationHistory.push({ role: 'assistant', content: assistantContent });
            this.conversationHistory.push({
              role: 'user',
              content: [{
                type: 'tool_result',
                tool_use_id: block.id,
                content: JSON.stringify(result),
              }],
            });
          }
        }

        // Check if we should continue (tool use requires another round)
        if (response.stop_reason === 'tool_use') {
          // Continue the loop to get the next response after tool results
          continueLoop = true;
        } else {
          // End of conversation turn
          if (assistantContent.length > 0 && !this.conversationHistory.some((m) => m.content === assistantContent)) {
            this.conversationHistory.push({ role: 'assistant', content: assistantContent });
          }
          continueLoop = false;
        }
      }

      callbacks.onComplete(fullResponse);
    } catch (err: any) {
      callbacks.onError(err.message || 'Unknown error during AI chat.');
    }
  }
}

// ─── System Prompt ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an AI video editing assistant inside Palmier Pro for Windows.
You have direct access to the video editor's timeline through tool calls.
You can read the project state, add/remove/move/trim/split clips, manage tracks,
and control the playhead.

Guidelines:
- Always read the current timeline state before making edits so you understand context.
- Explain what you're doing before and after tool calls.
- Use precise frame numbers. The project frame rate is available in the timeline data.
- When the user asks to "cut" something, use split_clip at the appropriate frame.
- When the user asks to "remove silence" or "trim", combine get_timeline reading with trim/split operations.
- Be efficient — batch related operations together.
- If an operation fails, explain why and suggest alternatives.`;
