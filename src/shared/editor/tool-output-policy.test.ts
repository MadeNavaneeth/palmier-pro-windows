import { describe, expect, it } from 'vitest';
import {
  TOOL_RESULT_KEEP_LAST,
  elideToolResults,
  elisionPlaceholder,
  isElidedToolResult,
} from './tool-output-policy';

function toolTurn(id: string, content: unknown, isError = false) {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }],
  };
}

function assistantTurn(text: string) {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

describe('elideToolResults (L4b)', () => {
  it('keeps the last N results verbatim and elides the rest', () => {
    const history = [
      assistantTurn('one'), toolTurn('t1', 'result-1'),
      assistantTurn('two'), toolTurn('t2', 'result-2'),
      assistantTurn('three'), toolTurn('t3', 'result-3'),
    ];

    const elided = elideToolResults(history, 2);

    // Only tool_result blocks carry `content`; assistant text blocks do not,
    // so the extractor filters by type rather than by shape.
    const contents = elided
      .flatMap((entry) => (Array.isArray(entry.content) ? (entry.content as Array<{ type?: string; content?: string }>) : []))
      .filter((block) => block.type === 'tool_result')
      .map((block) => block.content);
    expect(contents).toEqual([elisionPlaceholder(), 'result-2', 'result-3']);
  });

  it('never elides error results', () => {
    const history = [
      toolTurn('t1', 'failed: clip not found', true),
      toolTurn('t2', 'ok-1'),
      toolTurn('t3', 'ok-2'),
      toolTurn('t4', 'ok-3'),
    ];

    const elided = elideToolResults(history, 1);

    const first = (elided[0].content as Array<{ content: string }>)[0];
    expect(first.content).toBe('failed: clip not found');
  });

  it('preserves structure: message count, order, and tool_use ids', () => {
    const history = [toolTurn('t1', 'a'), toolTurn('t2', 'b'), toolTurn('t3', 'c')];
    const elided = elideToolResults(history, 1);

    expect(elided).toHaveLength(3);
    expect(elided.map((entry) => entry.role)).toEqual(['user', 'user', 'user']);
    expect(elided.map((entry) => (entry.content as Array<{ tool_use_id: string }>)[0].tool_use_id))
      .toEqual(['t1', 't2', 't3']);
  });

  it('is idempotent: an already-elided result is not re-wrapped', () => {
    const history = [toolTurn('t1', 'a'), toolTurn('t2', 'b'), toolTurn('t3', 'c')];
    const once = elideToolResults(history, 1);
    const twice = elideToolResults(once, 1);

    expect(twice).toBe(once);
    expect(isElidedToolResult((twice[0].content as Array<{ content: string }>)[0].content)).toBe(true);
  });

  it('returns the same array when nothing needs eliding', () => {
    const history = [toolTurn('t1', 'a'), toolTurn('t2', 'b')];
    expect(elideToolResults(history, TOOL_RESULT_KEEP_LAST)).toBe(history);
  });

  it('leaves non-tool content and text turns untouched', () => {
    const history = [assistantTurn('keep me'), { role: 'user', content: 'plain text' }];
    const elided = elideToolResults(history, 0);
    expect(elided).toBe(history);
  });
});
