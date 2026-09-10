import { describe, expect, it } from 'vitest';
import {
  CHARS_PER_TOKEN,
  CONTEXT_COMPACT_RATIO,
  DEFAULT_CONTEXT_WINDOW,
  SUMMARY_HEADER,
  SUMMARY_INPUT_CHARS,
  contextWindowFor,
  estimateOutgoingTokens,
  estimateTokens,
  isSummaryContent,
  renderTranscriptForSummary,
  shouldCompact,
  summarizeInstruction,
} from './context-budget';

describe('context budget (L4c)', () => {
  it('estimates tokens crudely but never zero for non-empty text', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a')).toBe(1);
    expect(estimateTokens('a'.repeat(CHARS_PER_TOKEN * 3))).toBe(3);
    // Rounds up, so a partial token is never free.
    expect(estimateTokens('a'.repeat(CHARS_PER_TOKEN * 3 + 1))).toBe(4);
  });

  it('uses the provider default window, and honours a sane override only', () => {
    expect(contextWindowFor('anthropic')).toBe(DEFAULT_CONTEXT_WINDOW.anthropic);
    expect(contextWindowFor('openai-compatible')).toBe(DEFAULT_CONTEXT_WINDOW['openai-compatible']);
    expect(contextWindowFor('anthropic', 8_000)).toBe(8_000);
    // Nonsense overrides fall back rather than disabling the guard.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(contextWindowFor('anthropic', bad)).toBe(DEFAULT_CONTEXT_WINDOW.anthropic);
    }
  });

  it('compacts at the threshold, not before', () => {
    const window = 1_000;
    expect(shouldCompact(window * CONTEXT_COMPACT_RATIO - 1, window)).toBe(false);
    expect(shouldCompact(window * CONTEXT_COMPACT_RATIO, window)).toBe(true);
    expect(shouldCompact(Number.POSITIVE_INFINITY, window)).toBe(false);
  });

  it('recognizes its own summary so it is not summarized again', () => {
    expect(isSummaryContent(`${SUMMARY_HEADER}\nnotes`)).toBe(true);
    expect(isSummaryContent('notes')).toBe(false);
  });

  it('sizes the outgoing request from system, history, tools and the new message', () => {
    const tokens = estimateOutgoingTokens({
      system: 'a'.repeat(CHARS_PER_TOKEN * 10),
      history: [{ role: 'user', content: 'a'.repeat(CHARS_PER_TOKEN * 10) }],
      tools: [{ name: 'get_timeline' }],
      userMessage: 'a'.repeat(CHARS_PER_TOKEN * 10),
    });
    expect(tokens).toBeGreaterThanOrEqual(30);
    expect(tokens).toBeLessThan(60);
  });

  it('renders a transcript with roles, and clamps huge tool results', () => {
    const transcript = renderTranscriptForSummary([
      { role: 'user', content: 'trim the intro' },
      { role: 'assistant', content: 'Done.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'here' },
          { type: 'tool_result', content: 'x'.repeat(5_000) },
        ],
      },
    ]);

    expect(transcript).toContain('User: trim the intro');
    expect(transcript).toContain('Assistant: Done.');
    expect(transcript).toContain('[tool result]');
    expect(transcript).toContain('[truncated]');
    expect(transcript.length).toBeLessThan(2_200);
  });

  it('drops the middle of an oversized transcript and says so', () => {
    const filler = { role: 'user', content: 'y'.repeat(4_000) };
    const transcript = renderTranscriptForSummary([filler, filler, filler, filler, filler], {
      totalChars: 5_000,
    });

    expect(transcript).toContain('[middle omitted]');
    // 40% head, 60% tail, plus the marker.
    expect(transcript.length).toBeLessThan(5_100);
    expect(transcript.startsWith(`User: ${'y'.repeat(10)}`)).toBe(true);
    expect(transcript.endsWith('y'.repeat(10))).toBe(true);
  });

  it('asks the summarizer to keep the specifics that matter for an edit', () => {
    const instruction = summarizeInstruction();
    for (const phrase of ['goals', 'decisions', 'state of the edit', 'failed', 'unfinished']) {
      expect(instruction).toContain(phrase);
    }
    expect(SUMMARY_INPUT_CHARS).toBeGreaterThan(0);
  });
});
