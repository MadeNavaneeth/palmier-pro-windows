/**
 * In-app AI Agent — BYOK (bring your own key) chat with tool use.
 * Uses @anthropic-ai/sdk for Claude, with a provider-agnostic interface
 * so other models (OpenAI, local) can be added later.
 *
 * The agent calls the same ToolExecutor the MCP server uses,
 * ensuring identical behavior whether driven locally or externally.
 */

import Anthropic from '@anthropic-ai/sdk';
import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { tools, toolsToJsonSchema, isReadOnlyTool } from './tools';
import { ToolExecutor, type ToolResult } from './executor';
import { skillIndexSection } from './skills';
import {
  createCompletion,
  parseToolArguments,
  toOpenAiTools,
  CancelledError,
  type OpenAiMessage,
} from './openai-compatible';
import { renderCodexHistory, runCodexCompletion } from './codex-cli';
import type { ProviderKind } from '../../shared/ai/provider-config';
import type { PlanStep } from '../../shared/editor/plan';
import { buildProjectDigest } from '../../shared/editor/project-digest';
import { elideToolResults } from '../../shared/editor/tool-output-policy';
import {
  SUMMARY_HEADER,
  contextWindowFor,
  estimateOutgoingTokens,
  renderTranscriptForSummary,
  shouldCompact,
  summarizeInstruction,
} from '../../shared/ai/context-budget';
import type { EditorController } from '../../shared/editor/controller';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentConfig {
  provider: ProviderKind;
  apiKey: string;
  /**
   * API root override (#17). Optional for Anthropic, where the SDK default is
   * used; required for `openai-compatible`, which has no default; unused by
   * `codex-cli`, which shells out to the CLI.
   */
  baseUrl?: string;
  model?: string;
  /**
   * Explicit `codex` binary override (upstream #142). Only read when the
   * provider is `codex-cli`.
   */
  binaryPath?: string;
  /**
   * Sandboxed working root for the Codex CLI's `-C` (upstream #142),
   * resolved by the IPC layer inside the project/media scope. Only read when
   * the provider is `codex-cli`.
   */
  workingDir?: string;
  maxTokens?: number;
  /**
   * Context window in tokens, when the deployment differs from the provider
   * default (L4c). Nonsensical values are ignored rather than trusted.
   */
  contextWindow?: number;
  /**
   * Where to append the raw turn transcript as JSON Lines, when the caller
   * wants the conversation auditable on disk (L4c). Compaction replaces
   * history, so without this the only record of what was dropped is gone.
   */
  transcriptPath?: string;
}

/**
 * Ceiling on tool-call rounds in a single turn.
 *
 * The loop continues while the model keeps asking for tools, so a model that
 * requests one on every round would otherwise spin indefinitely, burning tokens
 * and mutating the timeline with no way for the user to intervene.
 */
export const MAX_TOOL_ROUNDS = 12;

/**
 * Cap on read-only tools in flight at once (Track 2, L5).
 *
 * The parallelism is bounded because each call still has to validate and read
 * through the same controller, and because an unbounded fan-out from a model
 * that asks for ten lookups in one response is a latency regression rather than
 * a win.
 */
export const READ_ONLY_TOOL_CONCURRENCY = 4;

/**
 * Run `run` over `items` with at most `limit` in flight, preserving order.
 *
 * Results come back positionally, so callers never have to reason about
 * completion order.
 */
async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await run(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * A reply to one `tool_use` block, in the shape Anthropic expects.
 *
 * Every `tool_use` needs exactly one of these in the immediately following user
 * turn; `is_error` marks a call that was refused or interrupted rather than run.
 */
interface AnthropicToolResult {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface StreamCallbacks {
  onToken: (token: string) => void;
  onToolCall: (name: string, args: Record<string, unknown>) => void;
  onToolResult: (name: string, result: unknown) => void;
  onComplete: (fullResponse: string) => void;
  onError: (error: string) => void;
  /**
   * The user stopped the turn (upstream #58).
   *
   * Separate from `onError` because nothing failed: whatever the model had
   * already said is handed back so the transcript keeps it, and the panel shows
   * a stop rather than a failure.
   */
  onCancelled: (partialResponse: string) => void;
  /**
   * The model replaced its working plan (L3). Session UI state only — the
   * panel shows it; nothing else depends on it.
   */
  onPlan?: (plan: PlanStep[]) => void;
}

// ─── Agent ───────────────────────────────────────────────────────────────────

export class PalmierAgent {
  private executor: ToolExecutor;
  private editor: EditorController;
  private config: AgentConfig | null = null;
  private conversationHistory: any[] = [];
  /** Skills root for the prompt index and `load_skill` (Track 2, L7). */
  private skillsDir: string | undefined;
  /** Non-null exactly while a turn is running (upstream #58). */
  private turn: AbortController | null = null;
  /** Callbacks of the running turn, so tool-driven events can reach the UI. */
  private activeCallbacks: StreamCallbacks | null = null;
  /**
   * Latest plan the agent reported (L3), retained for windows that arrive
   * late: a detached chat adopts the session on boot and must see the same
   * checklist the docked panel showed, not an empty one until the next update.
   */
  private lastPlan: PlanStep[] | null = null;

  constructor(editor: EditorController, opts?: { skillsDir?: string }) {
    this.editor = editor;
    this.skillsDir = opts?.skillsDir;
    this.executor = new ToolExecutor(editor, {
      onPlanUpdate: (plan) => {
        this.lastPlan = plan;
        this.activeCallbacks?.onPlan?.(plan);
      },
      ...(opts?.skillsDir !== undefined ? { skillsDir: opts.skillsDir } : {}),
    });
  }

  /**
   * A deep copy of the session a late window needs to take over the visible
   * chat: the structured history plus the current plan checklist.
   *
   * Copied rather than referenced — the renderer must never hold a live handle
   * into the object the next tool round keeps appending to.
   */
  getSessionSnapshot(): { history: unknown[]; plan: PlanStep[] | null } {
    return {
      history: JSON.parse(JSON.stringify(this.conversationHistory)) as unknown[],
      plan: this.lastPlan === null ? null : (JSON.parse(JSON.stringify(this.lastPlan)) as PlanStep[]),
    };
  }

  /**
   * The system prompt for a turn: the static contract plus a digest derived
   * from the controller *right now* (L4). Regenerated per turn, never cached,
   * so it cannot drift away from the authoritative project.
   *
   * The Codex CLI runs one-shot per round with its own working directory, so
   * its turns carry one extra line naming the sandbox. Nothing else changes:
   * the tool catalog arrives in the CLI prompt, not here.
   */
  private systemPrompt(): string {
    const base = `${SYSTEM_PROMPT}\n\n${buildProjectDigest(this.editor.getProject())}`;
    // L7: names + descriptions only. Bodies reach the model solely as
    // `load_skill` results, never via the prompt — and an empty section is
    // omitted entirely so a skill-less setup pays nothing.
    const skills = skillIndexSection(this.skillsDir);
    const withSkills = skills.length > 0 ? `${base}\n\n${skills}` : base;
    if (this.config?.provider === 'codex-cli' && this.config.workingDir) {
      return `${withSkills}\n\nYour working directory is ${this.config.workingDir}. `
        + 'The CLI runs read-only: answer with tool calls, never file edits or shell commands.';
    }
    return withSkills;
  }

  configure(config: AgentConfig): void {
    this.config = config;
  }

  isConfigured(): boolean {
    if (!this.config) return false;
    // The Codex CLI authenticates with the user's own sign-in, so there is no
    // key or endpoint to check — binary availability is gated per turn with a
    // precise refusal instead.
    if (this.config.provider === 'codex-cli') return true;
    // A local runtime needs no key, but it does need somewhere to send the
    // request, so one of the two must be present.
    return this.config.apiKey.length > 0 || Boolean(this.config.baseUrl);
  }

  /** True while a turn is in flight, so the UI can offer Stop instead of Send. */
  isBusy(): boolean {
    return this.turn !== null;
  }

  /**
   * Stop the turn in progress. Returns false when there was nothing to stop.
   *
   * A tool already executing is allowed to finish: the executor mutates the
   * project through undoable commands, and tearing one down halfway is how a
   * timeline ends up in a state no single undo can reverse. The signal is
   * checked between rounds and before each remaining tool call instead.
   */
  cancel(): boolean {
    if (!this.turn) return false;
    this.turn.abort();
    return true;
  }

  clearHistory(): void {
    // A turn still running would otherwise keep appending to the history that
    // was just cleared, and its answer would arrive into an empty transcript.
    this.cancel();
    this.conversationHistory = [];
    // A cleared session must not hand a stale checklist to a late window.
    this.lastPlan = null;
  }

  async chat(userMessage: string, callbacks: StreamCallbacks): Promise<void> {
    if (!this.config) {
      callbacks.onError('Agent not configured. Set an API key first.');
      return;
    }
    if (this.turn) {
      callbacks.onError('A request is already running. Stop it before sending another.');
      return;
    }

    const turn = new AbortController();
    this.turn = turn;
    this.activeCallbacks = callbacks;
    try {
      this.appendTranscript({ event: 'user', content: userMessage });
      // Once per turn, before any request is built (L4c).
      await this.compactIfNeeded(userMessage, turn.signal);
      if (turn.signal.aborted) {
        callbacks.onCancelled('');
        return;
      }

      if (this.config.provider === 'anthropic') {
        await this.chatAnthropic(userMessage, callbacks, turn.signal);
      } else if (this.config.provider === 'openai-compatible') {
        await this.chatOpenAiCompatible(userMessage, callbacks, turn.signal);
      } else if (this.config.provider === 'codex-cli') {
        await this.chatCodexCli(userMessage, callbacks, turn.signal);
      } else {
        callbacks.onError(`Provider "${String(this.config.provider)}" not yet supported.`);
      }
    } finally {
      // Cleared even when the turn threw, or Stop would stay armed against a
      // request that is no longer running and the next send would be refused.
      this.turn = null;
      this.activeCallbacks = null;
    }
  }

  /**
   * OpenAI-compatible `/chat/completions` turn (#17, #140).
   *
   * Runs the same ToolExecutor as the Anthropic path and the MCP server, so an
   * edit means the same thing regardless of which model requested it.
   */
  private async chatOpenAiCompatible(
    userMessage: string,
    callbacks: StreamCallbacks,
    signal: AbortSignal,
  ): Promise<void> {
    const config = this.config!;
    if (!config.baseUrl) {
      callbacks.onError('This provider needs an API base URL. Set one in AI settings.');
      return;
    }
    if (!config.model) {
      callbacks.onError('This provider needs a model name. Set one in AI settings.');
      return;
    }

    const openAiTools = toOpenAiTools(toolsToJsonSchema());
    const messages: OpenAiMessage[] = [
      { role: 'system', content: this.systemPrompt() },
      ...this.openAiHistory(),
      { role: 'user', content: userMessage },
    ];
    this.conversationHistory.push({ role: 'user', content: userMessage });

    let fullResponse = '';

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
        const result = await createCompletion({
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          model: config.model,
          messages,
          tools: openAiTools,
          maxTokens: config.maxTokens || 4096,
          signal,
        });

        if (result.content) {
          fullResponse += result.content;
          callbacks.onToken(result.content);
        }

        if (!result.wantsTools) {
          messages.push({ role: 'assistant', content: result.content });
          this.conversationHistory.push({ role: 'assistant', content: result.content });
          this.appendTranscript({ event: 'assistant', content: fullResponse });
          callbacks.onComplete(fullResponse);
          return;
        }

        // The assistant turn that requested the tools must be replayed verbatim,
        // or the follow-up tool messages have no call to attach to.
        messages.push({
          role: 'assistant',
          content: result.content || null,
          tool_calls: result.toolCalls.map((call) => ({
            id: call.id,
            type: 'function' as const,
            function: { name: call.name, arguments: call.argumentsJson },
          })),
        });

        const calls = result.toolCalls.map((call) => ({
          name: call.name,
          args: parseToolArguments(call.argumentsJson),
        }));
        const outcomes = await this.runToolBatch(calls, signal, callbacks);
        if (outcomes.some((outcome) => outcome === null)) {
          // Stopped mid-batch: the local `messages` array is discarded, so no
          // tool call is left unanswered in the recorded history.
          this.recordCancelledTurn(fullResponse);
          callbacks.onCancelled(fullResponse);
          return;
        }
        outcomes.forEach((outcome, index) => {
          messages.push({
            role: 'tool',
            tool_call_id: result.toolCalls[index].id,
            content: JSON.stringify(outcome!.result),
          });
        });
      }

      // Ran out of rounds: report it rather than silently truncating the turn.
      callbacks.onError(
        `Stopped after ${MAX_TOOL_ROUNDS} tool rounds without a final answer. `
        + 'Try a narrower request.',
      );
    } catch (err) {
      if (err instanceof CancelledError || signal.aborted) {
        this.recordCancelledTurn(fullResponse);
        callbacks.onCancelled(fullResponse);
        return;
      }
      callbacks.onError(err instanceof Error ? err.message : 'Unknown error during AI chat.');
    }
  }

  /**
   * Codex CLI turn (upstream #142).
   *
   * The CLI is a completion backend inside this same tool loop: one `codex
   * exec` run per round, stateless (`--ephemeral`, no resume), with tool
   * results folded back into the next round's prompt. The loop bound, the
   * ToolExecutor semantics, the history shapes, and the cancellation contract
   * are the OpenAI-compatible path's, unchanged.
   *
   * Streamed tokens reach the UI live; the transcript records each round's
   * authoritative content, so a stream/parse disagreement cannot corrupt the
   * recorded history.
   */
  private async chatCodexCli(
    userMessage: string,
    callbacks: StreamCallbacks,
    signal: AbortSignal,
  ): Promise<void> {
    const config = this.config!;
    if (!config.workingDir) {
      callbacks.onError('Codex CLI needs a working directory. Check AI settings.');
      return;
    }

    const toolSchemas = toolsToJsonSchema().map((schema) => ({
      name: schema.name,
      description: schema.description,
    }));
    const system = this.systemPrompt();
    const priorHistory = renderCodexHistory(this.conversationHistory);
    this.conversationHistory.push({ role: 'user', content: userMessage });
    let roundContext = '';
    let fullResponse = '';

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
        const result = await runCodexCompletion({
          binaryPath: config.binaryPath,
          // Blank means the CLI default; there is no provider default to fall
          // back to, unlike the Anthropic path.
          model: config.model || undefined,
          workingDir: config.workingDir,
          system,
          history: priorHistory + roundContext,
          userMessage,
          tools: toolSchemas,
          signal,
          onToken: (token) => callbacks.onToken(token),
        });

        if (result.content) fullResponse += result.content;

        if (!result.wantsTools) {
          this.conversationHistory.push({ role: 'assistant', content: result.content });
          this.appendTranscript({ event: 'assistant', content: fullResponse });
          callbacks.onComplete(fullResponse);
          return;
        }

        const calls = result.toolCalls.map((call) => ({
          name: call.name,
          args: parseToolArguments(call.argumentsJson),
        }));
        const outcomes = await this.runToolBatch(calls, signal, callbacks);
        if (outcomes.some((outcome) => outcome === null)) {
          // Stopped mid-batch: tool results never reached the CLI (it is
          // stateless), so only completed text is recorded — same shape as
          // the OpenAI path's cancelled turn.
          this.recordCancelledTurn(fullResponse);
          callbacks.onCancelled(fullResponse);
          return;
        }
        roundContext += `\nAssistant: ${result.content}\n`
          + outcomes.map((outcome, index) => (
            `Tool ${result.toolCalls[index]!.name} returned: ${JSON.stringify(outcome!.result)}`
          )).join('\n');
      }

      // Ran out of rounds: report it rather than silently truncating the turn.
      callbacks.onError(
        `Stopped after ${MAX_TOOL_ROUNDS} tool rounds without a final answer. `
        + 'Try a narrower request.',
      );
    } catch (err) {
      if (err instanceof CancelledError || signal.aborted) {
        this.recordCancelledTurn(fullResponse);
        callbacks.onCancelled(fullResponse);
        return;
      }
      callbacks.onError(err instanceof Error ? err.message : 'Unknown error during AI chat.');
    }
  }

  /**
   * Run the tools one response asked for (Track 2, L5).
   *
   * Maximal runs of consecutive read-only calls run concurrently, bounded by
   * `READ_ONLY_TOOL_CONCURRENCY`; a mutating call is a barrier awaited on its
   * own, so a call that follows an edit still observes that edit. Results come
   * back in call order whatever order they completed in, because both providers
   * require one result per call in the order the calls were declared.
   *
   * A cancelled turn stops starting new calls; calls that never ran come back as
   * `null` so each caller can record them in its own shape.
   */
  private async runToolBatch(
    calls: readonly { name: string; args: Record<string, unknown> }[],
    signal: AbortSignal,
    callbacks: StreamCallbacks,
  ): Promise<({ name: string; result: ToolResult } | null)[]> {
    const outcomes: ({ name: string; result: ToolResult } | null)[] =
      new Array(calls.length).fill(null);

    let index = 0;
    while (index < calls.length) {
      if (signal.aborted) break;

      const start = index;
      if (isReadOnlyTool(calls[index].name)) {
        while (index < calls.length && isReadOnlyTool(calls[index].name)) index += 1;
      } else {
        index += 1;
      }
      const segment = calls.slice(start, index);

      for (const call of segment) callbacks.onToolCall(call.name, call.args);
      const results = await mapWithLimit(segment, READ_ONLY_TOOL_CONCURRENCY, (call) =>
        this.executor.execute(call.name, call.args));
      segment.forEach((call, offset) => {
        outcomes[start + offset] = { name: call.name, result: results[offset] };
        callbacks.onToolResult(call.name, results[offset]);
        this.appendTranscript({ event: 'tool', name: call.name, result: results[offset] });
      });
    }

    return outcomes;
  }

  /**
   * Keep whatever the model managed to say before it was stopped.
   *
   * Text only, and only for the OpenAI-shaped path, whose history holds plain
   * text messages. Recording a partial tool exchange there would leave a tool
   * call with no matching result, which providers reject on the next request — so
   * one interrupted turn would poison the rest of the conversation. The Anthropic
   * path keeps its blocks verbatim and records the partial text as part of the
   * assistant turn instead, so calling this for it would duplicate the text.
   */
  private recordCancelledTurn(partialResponse: string): void {
    if (partialResponse.length > 0) {
      this.conversationHistory.push({ role: 'assistant', content: partialResponse });
    }
  }

  /**
   * Add the user's message to the Anthropic history, preserving role alternation.
   *
   * A turn that was stopped, or that ran out of tool rounds, leaves the history
   * ending on the user turn that carries the tool results. Appending a second
   * user turn after it is rejected — roles have to alternate — so the text joins
   * the existing turn, which is the documented shape for "here are the results,
   * and here is what to do next". Without this, one stopped turn made every
   * later message in the conversation fail.
   */
  private pushAnthropicUserMessage(text: string): void {
    const last = this.conversationHistory[this.conversationHistory.length - 1];
    if (last?.role === 'user' && Array.isArray(last.content)) {
      last.content.push({ type: 'text', text });
      return;
    }
    this.conversationHistory.push({ role: 'user', content: text });
  }

  /**
   * Append one event to the raw transcript on disk (L4c), when configured.
   *
   * Auditing must never break a turn: an unwritable transcript path is ignored
   * rather than surfaced, matching how the rest of the app treats a failed
   * non-essential write. Appends are small and happen at turn boundaries and
   * tool completions, not inside a render or frame path.
   */
  private appendTranscript(entry: Record<string, unknown>): void {
    const path = this.config?.transcriptPath;
    if (!path) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, 'utf8');
    } catch {
      // Deliberately swallowed; see above.
    }
  }

  /** One-shot summarization call on whichever provider is configured. */
  private async summarize(transcript: string, signal: AbortSignal): Promise<string> {
    const config = this.config!;
    const instruction = summarizeInstruction();

    if (config.provider === 'codex-cli') {
      return this.summarizeCodex(transcript, signal);
    }

    if (config.provider === 'anthropic') {
      const client = new Anthropic({
        apiKey: config.apiKey,
        ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
      });
      const response = await client.messages.create(
        {
          model: config.model || 'claude-sonnet-4-20250514',
          max_tokens: 1024,
          system: instruction,
          messages: [{ role: 'user', content: transcript }],
        },
        { signal },
      );
      return response.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .filter((text) => text.length > 0)
        .join('\n')
        .trim();
    }

    const result = await createCompletion({
      baseUrl: config.baseUrl ?? '',
      apiKey: config.apiKey,
      model: config.model ?? '',
      messages: [
        { role: 'system', content: instruction },
        { role: 'user', content: transcript },
      ],
      tools: [],
      maxTokens: 1024,
      signal,
    });
    return result.content.trim();
  }

  /** One-shot Codex summarization: no tools, same backend as the turn. */
  private async summarizeCodex(transcript: string, signal: AbortSignal): Promise<string> {
    const config = this.config!;
    if (!config.workingDir) throw new Error('Codex CLI needs a working directory.');
    const result = await runCodexCompletion({
      binaryPath: config.binaryPath,
      model: config.model || undefined,
      workingDir: config.workingDir,
      system: summarizeInstruction(),
      history: '',
      userMessage: transcript,
      tools: [],
      signal,
    });
    return result.content.trim();
  }

  /**
   * Estimated cost of a request in tokens (L4c).
   *
   * The same arithmetic `compactIfNeeded` thresholds on, exposed so a caller
   * (and the tests) can reason about the budget without re-deriving it — an
   * approximation that disagrees with the decision is worse than no number.
   */
  private measureRequestTokens(history: unknown, userMessage: string): number {
    return estimateOutgoingTokens({
      system: this.systemPrompt(),
      history,
      tools: toolsToJsonSchema(),
      userMessage,
    });
  }

  /** Estimated cost of the next request, against the current history. */
  estimatedRequestTokens(userMessage: string): number {
    return this.measureRequestTokens(this.conversationHistory, userMessage);
  }

  /**
   * Compress the conversation when the next request would fill the window (L4c).
   *
   * Runs once per turn, before the request is built, and never mid-round: a
   * summary that landed between an assistant turn and its tool results would
   * leave a tool call unanswered, which both providers reject. Order of resort:
   * summarize, then — if even that does not bring the request under the
   * threshold — drop the past entirely, keeping only the freshly derived system
   * prompt and the user's new message.
   *
   * A summarization failure falls through to the same reset rather than failing
   * the turn: losing the backlog is bad, refusing to answer is worse.
   */
  private async compactIfNeeded(userMessage: string, signal: AbortSignal): Promise<void> {
    const config = this.config!;
    const contextWindow = contextWindowFor(config.provider, config.contextWindow);
    const measure = (history: unknown) => this.measureRequestTokens(history, userMessage);

    if (!shouldCompact(measure(this.conversationHistory), contextWindow)) return;
    // A provider that cannot take a request cannot take a summary request either.
    if (config.provider === 'openai-compatible' && (!config.baseUrl || !config.model)) return;
    if (config.provider === 'codex-cli' && !config.workingDir) return;

    const before = measure(this.conversationHistory);
    const entries = this.conversationHistory.length;
    this.appendTranscript({ event: 'compaction-start', estimatedTokens: before, contextWindow, entries });

    let summary = '';
    try {
      summary = await this.summarize(renderTranscriptForSummary(this.conversationHistory), signal);
    } catch (err) {
      this.appendTranscript({
        event: 'compaction-failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (summary.length > 0) {
      this.conversationHistory = [{ role: 'user', content: `${SUMMARY_HEADER}\n${summary}` }];
      const after = measure(this.conversationHistory);
      if (!shouldCompact(after, contextWindow)) {
        this.appendTranscript({ event: 'compacted', estimatedTokens: after, entries, summary });
        return;
      }
      this.appendTranscript({ event: 'reset', reason: 'summary still over window', estimatedTokens: after });
    } else if (!signal.aborted) {
      this.appendTranscript({ event: 'reset', reason: 'summarization unavailable', estimatedTokens: before });
    }

    // Last resort. The new user message is not in history yet, so nothing the
    // user just asked for is lost.
    this.conversationHistory = [];
  }

  /**
   * Prior turns as plain text, for the OpenAI message shape.
   *
   * Anthropic tool blocks are provider-specific and are not replayed; only the
   * user and assistant text carries across, which is enough context and avoids
   * sending one provider's internal block format to another. Text is read out of
   * block arrays as well as plain strings, because a message the user typed after
   * a stopped turn lives as a text block alongside the tool results, and dropping
   * it would silently lose what they asked for when they switch provider.
   */
  private openAiHistory(): OpenAiMessage[] {
    const history: OpenAiMessage[] = [];
    for (const entry of this.conversationHistory) {
      const role = (entry as { role?: unknown }).role;
      if (role !== 'user' && role !== 'assistant') continue;
      const content = textOf((entry as { content?: unknown }).content);
      if (content.length === 0) continue;
      history.push({ role, content });
    }
    return history;
  }

  private async chatAnthropic(
    userMessage: string,
    callbacks: StreamCallbacks,
    signal: AbortSignal,
  ): Promise<void> {
    // baseUrl lets a user route Claude through a gateway or proxy (#17); the SDK
    // default is used when it is absent.
    const client = new Anthropic({
      apiKey: this.config!.apiKey,
      ...(this.config!.baseUrl ? { baseURL: this.config!.baseUrl } : {}),
    });
    const model = this.config!.model || 'claude-sonnet-4-20250514';
    const maxTokens = this.config!.maxTokens || 4096;

    this.pushAnthropicUserMessage(userMessage);

    // Convert our tool schemas to Anthropic format
    const anthropicTools = Object.values(tools).map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: {
        type: 'object' as const,
        ...toolsToJsonSchema().find((t) => t.name === tool.name)?.inputSchema as Record<string, unknown>,
      },
    }));

    // Declared outside the try so a cancellation caught below can still hand
    // back whatever the model had already said.
    let fullResponse = '';

    try {
      let continueLoop = true;
      let rounds = 0;

      while (continueLoop) {
        // Bounded: a model that requests a tool every round would otherwise loop
        // forever, editing the timeline with no way to intervene.
        rounds += 1;
        if (rounds > MAX_TOOL_ROUNDS) {
          callbacks.onError(
            `Stopped after ${MAX_TOOL_ROUNDS} tool rounds without a final answer. `
            + 'Try a narrower request.',
          );
          return;
        }

        if (signal.aborted) {
          this.recordCancelledTurn(fullResponse);
          callbacks.onCancelled(fullResponse);
          return;
        }

        const response = await client.messages.create(
          {
            model,
            max_tokens: maxTokens,
            system: this.systemPrompt(),
            // Older tool observations ride along as placeholders (L4b): the
            // stored history keeps full fidelity, only the request is elided,
            // and message count/order/ids are untouched.
            messages: elideToolResults(this.conversationHistory),
            tools: anthropicTools,
          },
          { signal },
        );

        // A round is exactly two messages: one assistant turn carrying every
        // block the model produced, then one user turn carrying a tool_result for
        // each tool_use in the same order.
        //
        // Both are appended once, after the whole response has been processed.
        // Appending per block — as this used to — recorded the assistant turn
        // again for every tool and split the results across separate user turns,
        // so a response asking for two tools declared both in the first assistant
        // turn while the following user turn answered only the first. Anthropic
        // rejects that outright, which meant any multi-tool response broke the
        // turn on its next round.
        const assistantContent: any[] = [];
        const toolResults: AnthropicToolResult[] = [];
        let cancelled = false;

        // Collected first, executed after: the assistant turn has to be recorded
        // verbatim and in order, and collecting lets the batch runner decide
        // which calls can overlap.
        const pending: { block: any; cancelled: boolean }[] = [];
        for (const block of response.content) {
          if (block.type === 'text') {
            fullResponse += block.text;
            callbacks.onToken(block.text);
            assistantContent.push(block);
            continue;
          }

          // Replayed untouched: block kinds this build does not know about
          // (thinking, redacted content) still have to come back verbatim.
          assistantContent.push(block);
          if (block.type !== 'tool_use') continue;

          // Answered rather than skipped. Every tool_use needs a matching
          // tool_result, so leaving one unanswered would make the API reject
          // every later request in this conversation — one stop would end it.
          const alreadyStopped = cancelled || signal.aborted;
          if (alreadyStopped) cancelled = true;
          pending.push({ block, cancelled: alreadyStopped });
        }

        const runnable = pending.filter((entry) => !entry.cancelled);
        const outcomes = await this.runToolBatch(
          runnable.map((entry) => ({
            name: entry.block.name,
            args: entry.block.input as Record<string, unknown>,
          })),
          signal,
          callbacks,
        );
        if (signal.aborted) cancelled = true;

        let ran = 0;
        for (const entry of pending) {
          if (entry.cancelled) {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: entry.block.id,
              content: 'Cancelled by the user.',
              is_error: true,
            });
            continue;
          }
          const outcome = outcomes[ran];
          ran += 1;
          if (!outcome) {
            // Stopped before this call started.
            cancelled = true;
            toolResults.push({
              type: 'tool_result',
              tool_use_id: entry.block.id,
              content: 'Cancelled by the user.',
              is_error: true,
            });
            continue;
          }
          toolResults.push({
            type: 'tool_result',
            tool_use_id: entry.block.id,
            content: JSON.stringify(outcome.result),
          });
        }

        if (assistantContent.length > 0) {
          this.conversationHistory.push({ role: 'assistant', content: assistantContent });
        }
        if (toolResults.length > 0) {
          this.conversationHistory.push({ role: 'user', content: toolResults });
        }

        if (cancelled) {
          // The history already carries the partial text inside the assistant
          // turn above, so nothing is recorded separately here.
          callbacks.onCancelled(fullResponse);
          return;
        }

        // Driven by whether tools actually ran rather than by `stop_reason`
        // alone: results were just recorded as a user turn, and the model has to
        // answer them before the turn can end on an assistant message.
        continueLoop = toolResults.length > 0;
      }

      this.appendTranscript({ event: 'assistant', content: fullResponse });
      callbacks.onComplete(fullResponse);
    } catch (err: any) {
      // The SDK surfaces an aborted request as APIUserAbortError; the signal is
      // the reliable discriminator across SDK versions.
      if (signal.aborted) {
        this.recordCancelledTurn(fullResponse);
        callbacks.onCancelled(fullResponse);
        return;
      }
      callbacks.onError(err.message || 'Unknown error during AI chat.');
    }
  }
}

/**
 * Readable text in a message body, whether it is a plain string or a block array.
 *
 * Tool blocks carry no prose worth replaying, so only `text` blocks contribute.
 */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: 'text'; text: string } => {
      const candidate = block as { type?: unknown; text?: unknown };
      return candidate?.type === 'text' && typeof candidate.text === 'string';
    })
    .map((block) => block.text)
    .join('\n')
    .trim();
}

// ─── System Prompt ───────────────────────────────────────────────────────────

/**
 * The static contract every turn carries (L4 digest appended per turn).
 *
 * Exported so the fan-out eval (L6 gate) measures the same request the agent
 * sends rather than an approximation that could disagree with it.
 */
export const SYSTEM_PROMPT = `You are an AI video editing assistant inside Palmier Pro for Windows.
You have direct access to the video editor's timeline through tool calls.
Read the project state first, then make edits using the tools below.

## Available Capabilities

**Reading:** get_timeline (tracks/clips/settings/markers), get_clips, get_media. inspect_frame samples a frame from any library video/image at a given second and returns a PNG path you can read to actually SEE the footage — use it before describing or color-matching content, and to verify visual edits.

**Placement:** add_clip places media at a frame. Modes: overwrite (default), insert (pushes later clips right), append (after last clip on track).

**Trimming:** trim_clip adjusts In/Out points. trim_clips moves clip edges to absolute project frames for one or many clips in one undoable action (pass ripple=true to shift downstream material). split_clip cuts a clip in two at a frame.

**Ripple editing:** ripple_delete_clips removes clips and closes gaps across sync-locked tracks. ripple_delete_gap closes a specific empty span. ripple_delete_ranges extracts arbitrary ranges. ripple_trim_clip resizes a clip and shifts downstream material. Ripple receipts report shiftedMarkers and removedMarkerIds — patch review notes from those instead of re-reading the timeline.

**Markers:** manage_markers creates/updates/deletes review notes anchored to frames. Point markers have durationFrames 0; positive values make range markers. Status is open/review/resolved (defaults to open).

**Titles:** add_texts places styled text overlays (fontSize, color, bold, fontFamily, align, backgroundColor + padding, lineSpacing, fontCase, fillMode "footage"/"inverted", blurRadius, tiltX/tiltY, variable-font axes variationWght/variationWdth/variationSlnt/variationItal). set_title_text updates existing title text and style.

**Shapes:** add_shapes places vector tutorial overlays (rect/ellipse/line/arrow) with canvas-pixel geometry, stroke/fill styling, and animation presets (draw-on, slide-in-left, slide-in-right, slide-in-up, pop, spin, pulse — position/scale/rotation keyframes only; there is no opacity preset, use fades). set_shape_style restyles a shape clip. set_clip_motion animates video/image/shape clips per axis (x, y, r, sx, sy) with easing; titles stay static.

**Opacity animation:** set_clip_opacity_keyframes animates video/image/generated clip opacity with absolute-frame 0..1 keyframes and easing; points: [] clears the track. It is separate from fadeInFrames/fadeOutFrames, which remain independent.

**Captions:** import_srt / import_vtt place subtitle files as timed text overlays on a video track.

**Speed:** set_clip_speed changes constant playback speed (0.25x–4x) while keeping timeline duration fixed.

**Color grade:** set_clip_color_grade adjusts brightness (-1..1), contrast and saturation (0..3), hue rotation (-180..180), exposure (-5..5 EV, applied first), white balance (temperature 2000..11000K, tint -100..100), vibrance (-1..1), tonal levels (highlights, shadows, blacks, whites, each -1..1), tone curves, color wheels, hue curves, LUT and invert. The curves argument adds a master luma curve plus per-channel red/green/blue curves, each a list of {x, y} control points in 0-1 with strictly ascending x (up to 16 points, piecewise linear); an empty channel clears it, omitted channels stay, and an all-identity curve clears the field. The wheels argument adds lift/gamma/gain wheels (shadows/midtones/highlights): each zone is {x, y, m} with pad x/y in -1..1 plus a master (lift m -0.5..0.5 default 0, gamma m 0.5..2 default 1, gain m 0.5..1.5 default 1); omitted zones and components stay, and an all-identity wheels clears the field. The hueCurves argument adds hue-vs-hue/saturation/luminance curves, each a cyclic piecewise-linear list of {x, y} control points in 0-1 with strictly ascending x (up to 16 points), sampled at the pixel hue with near-greys gated out; an empty channel clears it, omitted channels stay, and an all-neutral set clears the field. The lutPath argument applies a .cube LUT file (1D or 3D, validated when set — a missing or invalid file refuses the call); lutIntensity blends it 0..1 (default 1, pass alone to re-blend the existing LUT); an empty lutPath clears the LUT. The blurRadius argument (0-100px gaussian blur, 0 clears), vignette ({amount -1..1, midpoint 0..1, roundness -1..1, feather 0..1}), grain ({amount 0..1, size 0.5..4, animated per frame}) and glow ({intensity 0..1, radius 0..100, threshold 0..1, warmth 0..1}) add the #157 effect stages after the grade; effect components merge per component (omitted stays), an all-identity effect clears it, and clear: true resets grade and effects together. Omitted fields stay; a field passed its default clears it. Preview and export apply identical values.

**Named grade/shot presets:** list_grade_presets lists saved looks; save_grade_preset captures a video/image clip's grade and normalized static shot fields under a unique name; rename_grade_preset and delete_grade_preset manage saved looks; apply_grade_preset targets one clip, a selection, or all current-timeline clips with allProjectClips:true, always in one undo step. It links the preset by default; pass linkPreset:false to clear the link. Omitting the target is refused, and all-project mode refuses the whole call if any project clip is ineligible. Deleted or manually edited links are inert metadata. Active motion tracks win over static shot fields.

**Audio:** normalize_audio analyzes peak level and adjusts volume to reach a target (-3 dBFS default). set_clip_pan sets stereo balance (-1 left … +1 right). set_clip_eq applies a three-band EQ (low 100 Hz shelf, mid 1 kHz bell, high 3 kHz shelf, ±15 dB; omitted bands stay, 0 clears a band, clear resets). set_clip_compressor applies threshold/ratio/attack/release/makeup (ratio 1 or clear removes it). set_clip_noise_reduction applies spectral denoise to an audio clip (strength 1-100; 0 or clear removes it). Audio fades use clip fadeIn/fadeOutFrames. remove_silence detects and ripples out silent gaps — pass clipIds to scope it, omit for the whole timeline; settings mirror the user's saved controls unless overridden per call.

**Tracks:** manage_tracks reorders, renames, toggles mute/hide/sync-lock, and removes empty tracks. add_track creates new tracks.

**Links:** manage_clip_links links or unlinks clips so they edit together. Linked A/V pairs are created automatically for video with embedded audio.

**Nesting:** nest_clips groups clips into a nested sequence (one compound clip replacing them, one undo step; linked partners nest together). flatten_compound restores one compound clip's content to the main timeline (one level, one undo step). Trim, split, and move work on the compound clip itself. nest_clips, flatten_compound, get_timeline, and get_clips take an optional scopeTimelineId to work inside a nested timeline (omit it for the main timeline); get_timeline also lists nested timelines when any exist, and verify_timeline audits every scope at once so it needs no scope argument.

**Media:** swap_clip_media replaces a clip's source file keeping all edits intact. describe_media generates a one-sentence AI description for a library image/video asset from a single frame via the user's own vision provider (explicit only — call it solely when the user asks to describe that asset; audio is refused, stored descriptions are searchable via get_media).

**Library folders:** manage_media_folders lists/creates/renames/deletes flat one-level media-library folders and moves assets between them (list first to get folder ids; each mutating call is one undo step; deleting a folder moves its assets to the library root and never deletes media).

**Styling extras:** set_clip_blend_mode (multiply/screen/overlay/…), set_clip_fade, set_clip_transition (wipe/slide), cross_dissolve between adjacent clips, copy_clip_settings to copy style from one clip to others.

**Generation:** generate_media creates an image/video/audio asset from a prompt via the configured providers (fal.ai, Replicate, HiggsField) and imports it into the library (pass referenceImagePath, an absolute path to a local image, to generate an image from an existing picture instead of the prompt alone; it is refused for video and audio) — then place it with add_clip like any other media. Requires the user to have set an API key in Settings → Media generation.

**Model recommendations (upstream #572):** every model named below is in the live provider catalog, and model ids are written in quotes; only name these, and only when the user's provider exposes it.
- **Images:** "fal-ai/flux-pro/v1.1" or "fal-ai/flux/dev" for quality; "fal-ai/ideogram/v2" and "fal-ai/recraft/v3" when the prompt has text to render; "fal-ai/flux/schnell" or "black-forest-labs/flux-schnell" for fast iteration. Every one of these accepts referenceImagePath.
- **Video:** "fal-ai/kling-video/v1/standard/text-to-video" for motion; "fal-ai/minimax-video/video-01" for short clips; "fal-ai/luma-dream-machine" for a softer look; "stability-ai/stable-video-diffusion:latest" on Replicate. These are text to video only. To reframe an existing shot, inspect_frame the source to write a png, then generate an image from that file with referenceImagePath and cut the result in.
- **Audio:** "meta/musicgen:latest" for music, "suno-ai/bark:latest" for speech and effects.
Choose the best available model from the configured providers. If a preferred model is unavailable, fall back to the provider default.

**Interchange:** export_fcpxml writes the timeline as Final Cut XML for Resolve/FCP/Premiere; import_fcpxml reads one back additively (new tracks per lane). Clip placement/trims, lanes, roles, titles (styling), static and keyframed opacity, transform (position/scale/rotation) including its keyframes, crop, volume and source timecode survive the trip; grades, effects, edge rounding/softness, crop keyframes, keyframed audio volume, audio fades and title transform/opacity keyframes are skipped and reported.

**Project files:** new_project, open_project, and save_project manage .vproj files directly, and export_project renders the timeline to a file with the same exporter the delivery panel uses (pass hdr:"hlg" or "pq" for a 10-bit BT.2020 HDR delivery on MP4/MOV) — mainly for MCP batch workflows.

**Verification:** verify_timeline is a read-only audit (zero-length clips, source overruns, overlaps, offline media, orphaned link groups, bad fades, empty titles/shapes, invalid markers). Run it after any destructive batch and fix what it reports before saying the edit is done.

**Settings:** set_project_settings changes fps/canvas/aspect ratio as one undoable step. undo/redo wrap everything above.

## Guidelines
- Always call get_timeline before making edits so you understand context.
- Explain what you're doing before and after tool calls.
- Use precise frame numbers. The project frame rate is in the timeline data.
- "Cut" means split_clip. "Remove silence" is one remove_silence call.
- When placing media, choose overwrite unless the user specifically asks to push existing content later (insert) or add after the end (append).
- Titles need a video track. Captions from SRT/VTT also go on video tracks.
- When the user references what's on screen ("that red car", "the logo"), inspect_frame the relevant clip first so your edits match reality.
- Batch related operations together for efficiency.
- If an operation fails, explain why and suggest alternatives.`;
