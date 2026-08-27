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
import {
  createCompletion,
  parseToolArguments,
  toOpenAiTools,
  CancelledError,
  type OpenAiMessage,
} from './openai-compatible';
import type { ProviderKind } from '../../shared/ai/provider-config';
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
   * used; required for `openai-compatible`, which has no default.
   */
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
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
}

// ─── Agent ───────────────────────────────────────────────────────────────────

export class PalmierAgent {
  private executor: ToolExecutor;
  private config: AgentConfig | null = null;
  private conversationHistory: any[] = [];
  /** Non-null exactly while a turn is running (upstream #58). */
  private turn: AbortController | null = null;

  constructor(editor: EditorController) {
    this.executor = new ToolExecutor(editor);
  }

  configure(config: AgentConfig): void {
    this.config = config;
  }

  isConfigured(): boolean {
    if (!this.config) return false;
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
    try {
      if (this.config.provider === 'anthropic') {
        await this.chatAnthropic(userMessage, callbacks, turn.signal);
      } else if (this.config.provider === 'openai-compatible') {
        await this.chatOpenAiCompatible(userMessage, callbacks, turn.signal);
      } else {
        callbacks.onError(`Provider "${String(this.config.provider)}" not yet supported.`);
      }
    } finally {
      // Cleared even when the turn threw, or Stop would stay armed against a
      // request that is no longer running and the next send would be refused.
      this.turn = null;
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
      { role: 'system', content: SYSTEM_PROMPT },
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

        for (const call of result.toolCalls) {
          // Checked per call rather than per round: a response asking for six
          // edits should stop at the one the user interrupted, not run them all.
          if (signal.aborted) {
            this.recordCancelledTurn(fullResponse);
            callbacks.onCancelled(fullResponse);
            return;
          }
          const args = parseToolArguments(call.argumentsJson);
          callbacks.onToolCall(call.name, args);
          const toolResult = await this.executor.execute(call.name, args);
          callbacks.onToolResult(call.name, toolResult);
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(toolResult),
          });
        }
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
            system: SYSTEM_PROMPT,
            messages: this.conversationHistory,
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

          if (cancelled || signal.aborted) {
            cancelled = true;
            // Answered rather than skipped. Every tool_use needs a matching
            // tool_result, so leaving one unanswered would make the API reject
            // every later request in this conversation — one stop would end it.
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: 'Cancelled by the user.',
              is_error: true,
            });
            continue;
          }

          callbacks.onToolCall(block.name, block.input as Record<string, unknown>);
          const result = await this.executor.execute(
            block.name,
            block.input as Record<string, unknown>,
          );
          callbacks.onToolResult(block.name, result);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result),
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

const SYSTEM_PROMPT = `You are an AI video editing assistant inside Palmier Pro for Windows.
You have direct access to the video editor's timeline through tool calls.
Read the project state first, then make edits using the tools below.

## Available Capabilities

**Reading:** get_timeline (tracks/clips/settings/markers), get_clips, get_media. inspect_frame samples a frame from any library video/image at a given second and returns a PNG path you can read to actually SEE the footage — use it before describing or color-matching content, and to verify visual edits.

**Placement:** add_clip places media at a frame. Modes: overwrite (default), insert (pushes later clips right), append (after last clip on track).

**Trimming:** trim_clip adjusts In/Out points. split_clip cuts a clip in two at a frame.

**Ripple editing:** ripple_delete_clips removes clips and closes gaps across sync-locked tracks. ripple_delete_gap closes a specific empty span. ripple_delete_ranges extracts arbitrary ranges. ripple_trim_clip resizes a clip and shifts downstream material.

**Markers:** manage_markers creates/updates/deletes review notes anchored to frames. Point markers have durationFrames 0; positive values make range markers.

**Titles:** add_texts places styled text overlays (fontSize, color, bold, fontFamily, align, backgroundColor + padding, lineSpacing, fontCase, fillMode "footage"/"inverted", blurRadius, tiltX/tiltY). set_title_text updates existing title text and style.

**Captions:** import_srt / import_vtt place subtitle files as timed text overlays on a video track.

**Speed:** set_clip_speed changes constant playback speed (0.25x–4x) while keeping timeline duration fixed.

**Audio:** normalize_audio analyzes peak level and adjusts volume to reach a target (-3 dBFS default). set_clip_pan sets stereo balance (-1 left … +1 right). Audio fades use clip fadeIn/fadeOutFrames. remove_silence detects and ripples out silent gaps — pass clipIds to scope it, omit for the whole timeline; settings mirror the user's saved controls unless overridden per call.

**Tracks:** manage_tracks reorders, renames, toggles mute/hide/sync-lock, and removes empty tracks. add_track creates new tracks.

**Links:** manage_clip_links links or unlinks clips so they edit together. Linked A/V pairs are created automatically for video with embedded audio.

**Media:** swap_clip_media replaces a clip's source file keeping all edits intact.

**Styling extras:** set_clip_blend_mode (multiply/screen/overlay/…), set_clip_fade, set_clip_transition (wipe/slide), cross_dissolve between adjacent clips, copy_clip_settings to copy style from one clip to others.

**Generation:** generate_media creates an image/video/audio asset from a prompt via the configured providers (fal.ai, Replicate, HiggsField) and imports it into the library — then place it with add_clip like any other media. Requires the user to have set an API key in Settings → Media generation.

**Model recommendations (upstream #572):**
- **Images:** Seedream or GPT Image for high-quality results; fal-ai/flux/dev for fast iteration.
- **Video:** Seedance 2.5 for text-to-video; MiniMax H3 with a reference image for video-to-video reframe.
- **Audio:** Replicate's meta/musicgen for music generation.
Choose the best available model from the configured providers. If a preferred model is unavailable, fall back to the provider default.

**Interchange:** export_fcpxml writes the timeline as Final Cut XML for Resolve/FCP/Premiere; import_fcpxml reads one back additively (new tracks per lane). Effects/grades inside FCPXML files are skipped and reported.

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
