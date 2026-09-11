/**
 * Chat session hand-off (upstream #286).
 *
 * The Agent's visible transcript is per-window renderer state, so a detached
 * chat adopts the main-process session on boot instead of starting blank.
 * This module converts that structured history into visible store state:
 * assistant text becomes messages, tool_use/tool_result pairs become the same
 * receipts the live turn appended, and the plan becomes the checklist.
 * Anything malformed degrades to an empty chat, never a crash.
 *
 * Pure, so the store and the tests read the same rules.
 */

import { normalizePlan, type PlanStep } from '../editor/plan';

/** One visible transcript row, before the store stamps it. */
export interface AdoptedMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  success?: boolean;
}

export interface AdoptedSession {
  messages: AdoptedMessage[];
  plan: PlanStep[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Plain strings pass through; block arrays contribute their text blocks. */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string') {
      parts.push(block['text']);
    }
  }
  return parts.join('\n');
}

interface AdoptedToolUse {
  id: string;
  name: string;
  input: unknown;
}

function toolUses(content: unknown): AdoptedToolUse[] {
  if (!Array.isArray(content)) return [];
  const uses: AdoptedToolUse[] = [];
  for (const block of content) {
    if (!isRecord(block) || block['type'] !== 'tool_use') continue;
    if (typeof block['id'] !== 'string' || typeof block['name'] !== 'string') continue;
    uses.push({ id: block['id'], name: block['name'], input: block['input'] });
  }
  return uses;
}

/** tool_result blocks of a user turn, keyed by the call they answer. */
function toolResults(content: unknown): Map<string, Record<string, unknown>> {
  const results = new Map<string, Record<string, unknown>>();
  if (!Array.isArray(content)) return results;
  for (const block of content) {
    if (!isRecord(block) || block['type'] !== 'tool_result') continue;
    if (typeof block['tool_use_id'] !== 'string') continue;
    results.set(block['tool_use_id'], block);
  }
  return results;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (typeof content === 'undefined') return '';
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (isRecord(block) && typeof block['text'] === 'string') return block['text'];
        try {
          return JSON.stringify(block) ?? '';
        } catch {
          return '';
        }
      })
      .join('\n');
  }
  try {
    return JSON.stringify(content) ?? '';
  } catch {
    return '';
  }
}

function formatArgs(input: unknown): { args?: Record<string, unknown>; text: string } {
  if (!isRecord(input)) return { text: '' };
  try {
    return { args: input, text: JSON.stringify(input, null, 2) ?? '' };
  } catch {
    return { args: input, text: '' };
  }
}

/**
 * Accept both plan key spellings: the tool schema uses `step`, older rows may
 * use `title`. Everything else (caps, single in-progress) is normalizePlan's.
 */
function normalizeAdoptedPlan(plan: unknown): PlanStep[] {
  if (!Array.isArray(plan)) return [];
  return normalizePlan(
    plan.map((entry) => {
      if (!isRecord(entry)) return entry;
      if (typeof entry['step'] === 'string') return entry;
      if (typeof entry['title'] === 'string') return { ...entry, step: entry['title'] };
      return entry;
    }),
  );
}

/**
 * Convert a `getSessionSnapshot` history into the visible transcript.
 *
 * A round is an assistant turn plus the user turn answering it, so each
 * tool_use is paired with its tool_result by id — the same call-then-result
 * receipts a live turn appends. An unpaired call still renders its receipt; a
 * missing answer must not swallow the call that was made. tool_result blocks
 * never render standalone, and empty text never becomes a bubble.
 */
export function adoptChatSession(history: unknown, plan: unknown): AdoptedSession {
  const messages: AdoptedMessage[] = [];
  const entries = Array.isArray(history) ? history : [];
  entries.forEach((entry, index) => {
    if (!isRecord(entry)) return;
    const role = entry['role'];
    const content = entry['content'];
    if (role === 'user') {
      const text = messageText(content);
      if (text.length > 0) messages.push({ role: 'user', content: text });
      return;
    }
    if (role !== 'assistant') return;
    const text = messageText(content);
    if (text.length > 0) messages.push({ role: 'assistant', content: text });
    const uses = toolUses(content);
    if (uses.length === 0) return;
    const next = entries[index + 1];
    const results =
      isRecord(next) && next['role'] === 'user'
        ? toolResults(next['content'])
        : new Map<string, Record<string, unknown>>();
    for (const use of uses) {
      const { args, text: argsText } = formatArgs(use.input);
      messages.push({
        role: 'tool',
        content: argsText,
        toolName: use.name,
        ...(args ? { toolArgs: args } : {}),
      });
      const result = results.get(use.id);
      if (!result) continue;
      messages.push({
        role: 'tool',
        content: toolResultText(result['content']),
        toolName: `${use.name} → result`,
        success: result['is_error'] !== true,
      });
    }
  });
  return { messages, plan: normalizeAdoptedPlan(plan) };
}
