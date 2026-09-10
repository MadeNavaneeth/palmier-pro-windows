/**
 * Context budget and summarization input (Track 2, L4c — docs/AGENTIC_ROADMAP.md).
 *
 * The last piece of the context-discipline layer: the cheap compactions (the
 * derived digest, and eliding old tool results) run on every turn, but a long
 * enough conversation still outgrows the provider window. This module decides
 * when that has happened and prepares the material for one summarization call.
 *
 * It is pure and provider-agnostic on purpose. The expensive decision — spend a
 * model call to compress the past — must be testable without a model, and the
 * character-to-token estimate must be the same number everywhere rather than
 * re-derived at each call site.
 *
 * The estimate is deliberately crude (four characters per token). It is used for
 * a 90% threshold, not for billing, and a conservative constant is the right
 * trade against pulling a tokenizer into the main process.
 */

import type { ProviderKind } from './provider-config';

/** Roughly four characters per token for English prose and JSON. */
export const CHARS_PER_TOKEN = 4;

/**
 * Conservative default windows, in tokens.
 *
 * Anthropic's current models are 200k; the OpenAI-compatible path is a
 * heterogeneous set of endpoints (OpenAI, OpenRouter, Groq, Together, Ollama,
 * LM Studio) where the safe assumption is the smaller common denominator. A
 * deployment with a different window sets it explicitly.
 */
export const DEFAULT_CONTEXT_WINDOW: Record<ProviderKind, number> = {
  anthropic: 200_000,
  'openai-compatible': 128_000,
};

/** Compact once the outgoing request is within a tenth of the window. */
export const CONTEXT_COMPACT_RATIO = 0.9;

/** Marks a turn that replaced older history, so it is not summarized again. */
export const SUMMARY_HEADER = '[Earlier conversation, summarized to fit the context window]';

/** Per-tool-result clamp when rendering a transcript for the summarizer. */
export const SUMMARY_TOOL_RESULT_CHARS = 2_000;

/** Total transcript clamp; beyond this the middle is dropped. */
export const SUMMARY_INPUT_CHARS = 200_000;

/** Non-empty text costs at least one token, so an empty estimate is never 0. */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * The window to budget against: an explicit positive setting, otherwise the
 * provider default. A nonsensical override is ignored rather than trusted,
 * matching how every other user-writable value in this codebase is narrowed.
 */
export function contextWindowFor(provider: ProviderKind, explicit?: number): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) {
    return Math.floor(explicit);
  }
  return DEFAULT_CONTEXT_WINDOW[provider];
}

/** True when a request of `usedTokens` has reached the compaction threshold. */
export function shouldCompact(usedTokens: number, contextWindow: number): boolean {
  if (!Number.isFinite(usedTokens) || contextWindow <= 0) return false;
  return usedTokens >= contextWindow * CONTEXT_COMPACT_RATIO;
}

export function isSummaryContent(text: string): boolean {
  return text.startsWith(SUMMARY_HEADER);
}

/** What the outgoing request will cost, measured on the payload we serialize. */
export function estimateOutgoingTokens(input: {
  system: string;
  history: unknown;
  tools: unknown;
  userMessage: string;
}): number {
  return estimateTokens(input.system)
    + estimateTokens(safeJson(input.history))
    + estimateTokens(safeJson(input.tools))
    + estimateTokens(input.userMessage);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/**
 * Flatten conversation history into a plain transcript for the summarizer.
 *
 * Bounded twice: each tool result is clamped, because one `get_timeline` dump
 * can dwarf the conversation around it, and the whole transcript is clamped by
 * dropping the middle. The beginning is kept because it carries what the user
 * asked for; the end is kept because it carries where the work stands; the
 * omitted middle is marked explicitly so the summarizer knows something is
 * missing rather than assuming the transcript is complete.
 */
export function renderTranscriptForSummary(
  entries: readonly unknown[],
  options: { perToolResultChars?: number; totalChars?: number } = {},
): string {
  const perTool = options.perToolResultChars ?? SUMMARY_TOOL_RESULT_CHARS;
  const total = options.totalChars ?? SUMMARY_INPUT_CHARS;

  const lines: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as { role?: unknown; content?: unknown };
    const role = record.role === 'assistant' ? 'Assistant' : 'User';
    const rendered = renderContent(record.content, perTool);
    if (rendered.length === 0) continue;
    lines.push(`${role}: ${rendered}`);
  }

  const transcript = lines.join('\n\n');
  if (transcript.length <= total) return transcript;

  const headChars = Math.floor(total * 0.4);
  const tailChars = total - headChars;
  return `${transcript.slice(0, headChars)}\n\n… [middle omitted] …\n\n${transcript.slice(-tailChars)}`;
}

function renderContent(content: unknown, perToolChars: number): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const block of content) {
    const candidate = block as { type?: unknown; text?: unknown; content?: unknown };
    if (candidate?.type === 'text' && typeof candidate.text === 'string') {
      parts.push(candidate.text);
    } else if (candidate?.type === 'tool_result') {
      // Tool blocks carry no prose, but the summarizer needs to know what the
      // tools returned, so the payload is included in clamped form.
      const payload = typeof candidate.content === 'string'
        ? candidate.content
        : safeJson(candidate.content);
      parts.push(`[tool result] ${clamp(payload, perToolChars)}`);
    }
  }
  return parts.join('\n').trim();
}

function clamp(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… [truncated]`;
}

/** The instruction sent with the transcript to produce the summary. */
export function summarizeInstruction(): string {
  return [
    'Compress the conversation below into terse notes that let an AI video editor',
    'continue the work with no other context.',
    '',
    'Preserve, and invent nothing:',
    "- the user's goals and any explicit constraints or preferences they stated;",
    '- decisions already made, including rejected approaches and why;',
    '- the current state of the edit, naming clips, tracks and markers concretely;',
    '- which tool calls failed and how, so the same mistake is not repeated;',
    '- what work is unfinished.',
    '',
    'Write the notes as short labeled lines, not prose. Do not address the user.',
    'Do not include tool schemas or raw tool output.',
  ].join('\n');
}
