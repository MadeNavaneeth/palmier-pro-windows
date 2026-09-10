/**
 * Read-only tool parallelism (Track 2, L5 — see docs/AGENTIC_ROADMAP.md).
 *
 * Proving concurrency without timing assertions: each test installs a barrier
 * that only releases once every expected call has *started*. Under the old
 * serial loop the first call would wait on a barrier nobody else can reach and
 * the test would time out, so a green run is a structural proof that the calls
 * overlapped rather than a lucky scheduling observation.
 *
 * Order is asserted separately, because the whole point of fanning out is that
 * completion order stops matching call order — the recorded history still has
 * to.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  sent: [] as { role: string; content: unknown }[][],
}));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: (params: { messages: { role: string; content: unknown }[] }, options?: unknown) => {
        mocks.sent.push(JSON.parse(JSON.stringify(params.messages)));
        return mocks.create(params, options);
      },
    };
  },
}));

import { PalmierAgent, type StreamCallbacks } from './agent';
import { ToolExecutor } from './executor';
import { READ_ONLY_TOOLS, isReadOnlyTool, toolsToJsonSchema } from './tools';
import { EditorController } from '../../shared/editor/controller';

const CONFIG = { provider: 'anthropic' as const, apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' };

function callbacks(): StreamCallbacks {
  return {
    onToken: () => {},
    onToolCall: () => {},
    onToolResult: () => {},
    onComplete: () => {},
    onError: (error) => { throw new Error(`unexpected agent error: ${error}`); },
    onCancelled: () => {},
  };
}

function toolTurn(calls: { id: string; name: string }[]) {
  return {
    content: calls.map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: {} })),
    stop_reason: 'tool_use',
  };
}

function textTurn(text: string) {
  return { content: [{ type: 'text', text }], stop_reason: 'end_turn' };
}

/** Tool-result contents of the last request the SDK was handed, in order. */
function sentResultContents(): string[] {
  const last = mocks.sent.at(-1) ?? [];
  return last
    .flatMap((entry) => (Array.isArray(entry.content) ? entry.content : []))
    .filter((block: { type?: string }) => block.type === 'tool_result')
    .map((block: { content?: string }) => block.content ?? '');
}

beforeEach(() => {
  mocks.create.mockReset();
  mocks.sent.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('tool classification (L5)', () => {
  it('names only real tools, defaults everything else to mutating', () => {
    const names = toolsToJsonSchema().map((tool) => tool.name);
    for (const name of READ_ONLY_TOOLS) expect(names).toContain(name);
    // Unknown and known-mutating tools are serialized.
    expect(isReadOnlyTool('split_clip')).toBe(false);
    expect(isReadOnlyTool('not_a_tool')).toBe(false);
    // At least one read-only tool, or the parallelism contract is vacuous.
    expect(READ_ONLY_TOOLS.size).toBeGreaterThan(0);
  });
});

describe('read-only tool parallelism (L5)', () => {
  it('starts a run of read-only calls before any of them finishes', async () => {
    const started: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });

    vi.spyOn(ToolExecutor.prototype, 'execute').mockImplementation(async (name: string) => {
      started.push(name);
      if (started.length === 3) release();
      // Would never resolve if the loop awaited each call in turn.
      await gate;
      return { success: true, data: { tag: name } };
    });

    mocks.create
      .mockResolvedValueOnce(toolTurn([
        { id: 't1', name: 'get_timeline' },
        { id: 't2', name: 'get_clips' },
        { id: 't3', name: 'get_media' },
      ]))
      .mockResolvedValueOnce(textTurn('Looked.'));

    const agent = new PalmierAgent(new EditorController());
    agent.configure(CONFIG);
    await agent.chat('look at everything', callbacks());

    expect(started).toHaveLength(3);
    expect(started).toEqual(['get_timeline', 'get_clips', 'get_media']);
  });

  it('records results in call order even when they complete in reverse', async () => {
    const delays: Record<string, number> = { get_timeline: 60, get_clips: 30, get_media: 0 };
    vi.spyOn(ToolExecutor.prototype, 'execute').mockImplementation(async (name: string) => {
      await new Promise((resolve) => setTimeout(resolve, delays[name] ?? 0));
      return { success: true, data: { tag: name } };
    });

    mocks.create
      .mockResolvedValueOnce(toolTurn([
        { id: 't1', name: 'get_timeline' },
        { id: 't2', name: 'get_clips' },
        { id: 't3', name: 'get_media' },
      ]))
      .mockResolvedValueOnce(textTurn('Looked.'));

    const agent = new PalmierAgent(new EditorController());
    agent.configure(CONFIG);
    await agent.chat('look', callbacks());

    expect(sentResultContents()).toEqual([
      JSON.stringify({ success: true, data: { tag: 'get_timeline' } }),
      JSON.stringify({ success: true, data: { tag: 'get_clips' } }),
      JSON.stringify({ success: true, data: { tag: 'get_media' } }),
    ]);
  });

  it('does not cancel siblings when one read-only call fails', async () => {
    vi.spyOn(ToolExecutor.prototype, 'execute').mockImplementation(async (name: string) =>
      (name === 'get_clips'
        ? { success: false, error: 'no clips' }
        : { success: true, data: { tag: name } }));

    mocks.create
      .mockResolvedValueOnce(toolTurn([
        { id: 't1', name: 'get_timeline' },
        { id: 't2', name: 'get_clips' },
        { id: 't3', name: 'get_media' },
      ]))
      .mockResolvedValueOnce(textTurn('Looked.'));

    const agent = new PalmierAgent(new EditorController());
    agent.configure(CONFIG);
    await agent.chat('look', callbacks());

    expect(sentResultContents()).toEqual([
      JSON.stringify({ success: true, data: { tag: 'get_timeline' } }),
      JSON.stringify({ success: false, error: 'no clips' }),
      JSON.stringify({ success: true, data: { tag: 'get_media' } }),
    ]);
  });

  it('serializes a mutation as a barrier between read-only runs', async () => {
    const events: string[] = [];
    vi.spyOn(ToolExecutor.prototype, 'execute').mockImplementation(async (name: string) => {
      events.push(`start:${name}`);
      // Slow read-only calls make a missing barrier obvious.
      await new Promise((resolve) => setTimeout(resolve, name === 'get_media' ? 20 : 5));
      events.push(`end:${name}`);
      return { success: true, data: { tag: name } };
    });

    mocks.create
      .mockResolvedValueOnce(toolTurn([
        { id: 't1', name: 'get_timeline' },
        { id: 't2', name: 'split_clip' },
        { id: 't3', name: 'get_media' },
      ]))
      .mockResolvedValueOnce(textTurn('Done.'));

    const agent = new PalmierAgent(new EditorController());
    agent.configure(CONFIG);
    await agent.chat('split then look', callbacks());

    // The mutation must not start until the read-only run ahead of it finished,
    // and the run after it must not start until the mutation finished.
    expect(events.indexOf('start:split_clip')).toBeGreaterThan(events.indexOf('end:get_timeline'));
    expect(events.indexOf('end:split_clip')).toBeLessThan(events.indexOf('start:get_media'));
  });
});
