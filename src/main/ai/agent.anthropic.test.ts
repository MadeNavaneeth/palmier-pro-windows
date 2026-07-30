/**
 * Regression coverage for the Anthropic conversation history (upstream #58).
 *
 * The behaviour under test is the shape of what gets replayed, because the API
 * refuses malformed history outright and the failure surfaces one round later as
 * an opaque 400. Three invariants matter:
 *
 *   - a round is exactly one assistant turn plus, when tools ran, one user turn
 *     carrying a tool_result for every tool_use in the same order;
 *   - roles alternate, so a turn that was stopped or that ran out of rounds
 *     cannot leave two user turns in a row;
 *   - no tool_use is ever left unanswered, since one unanswered call makes every
 *     later request in the conversation fail.
 *
 * The SDK is mocked because the assertion is the request payload, not the network.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  /**
   * A snapshot of the messages per round.
   *
   * The agent hands the SDK its live history array, so reading it back off the
   * mock's recorded call would show the state at the end of the turn rather than
   * what was actually sent on that round.
   */
  sent: [] as { role: string; content: unknown }[][],
}));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: (params: { messages: unknown }, options?: unknown) => {
        mocks.sent.push(JSON.parse(JSON.stringify(params.messages)));
        return mocks.create(params, options);
      },
    };
  },
}));

import { PalmierAgent, MAX_TOOL_ROUNDS, type StreamCallbacks } from './agent';
import { EditorController } from '../../shared/editor/controller';

const CONFIG = {
  provider: 'anthropic' as const,
  apiKey: 'sk-ant-test',
  model: 'claude-sonnet-4-20250514',
};

interface Recorded {
  tokens: string[];
  toolCalls: string[];
  completed: string | null;
  error: string | null;
  cancelled: string | null;
}

function recorder(): { callbacks: StreamCallbacks; log: Recorded } {
  const log: Recorded = {
    tokens: [], toolCalls: [], completed: null, error: null, cancelled: null,
  };
  return {
    log,
    callbacks: {
      onToken: (token) => log.tokens.push(token),
      onToolCall: (name) => log.toolCalls.push(name),
      onToolResult: () => {},
      onComplete: (full) => { log.completed = full; },
      onError: (error) => { log.error = error; },
      onCancelled: (partial) => { log.cancelled = partial; },
    },
  };
}

function harness() {
  const controller = new EditorController();
  controller.addMedia({
    id: 'asset',
    path: 'C:\\media\\clip.mp4',
    filename: 'clip.mp4',
    type: 'video',
    duration: 300,
    fileSize: 100,
    addedAt: '2026-07-29T00:00:00.000Z',
  });
  const clipId = controller.addClip({
    assetId: 'asset', trackId: 'v1', startFrame: 0, durationFrames: 120,
  }) as string;
  return { controller, clipId, agent: new PalmierAgent(controller) };
}

function textTurn(text: string) {
  return { content: [{ type: 'text', text }], stop_reason: 'end_turn' };
}

function toolTurn(
  calls: { id: string; name: string; input: unknown }[],
  text?: string,
) {
  return {
    content: [
      ...(text ? [{ type: 'text', text }] : []),
      ...calls.map((call) => ({
        type: 'tool_use', id: call.id, name: call.name, input: call.input,
      })),
    ],
    stop_reason: 'tool_use',
  };
}

/** Message arrays as they were handed to the API, one entry per round. */
function sentRounds(): { role: string; content: unknown }[][] {
  return mocks.sent;
}

type Block = { type: string; id?: string; tool_use_id?: string; is_error?: boolean };

function blocks(content: unknown): Block[] {
  return Array.isArray(content) ? (content as Block[]) : [];
}

/**
 * Assert the invariants the API enforces: alternating roles, and every tool_use
 * answered by a tool_result in the immediately following user turn, in order.
 */
function expectWellFormed(messages: { role: string; content: unknown }[]): void {
  expect(messages[0].role).toBe('user');
  for (let i = 1; i < messages.length; i += 1) {
    expect(messages[i].role).not.toBe(messages[i - 1].role);
  }
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i].role !== 'assistant') continue;
    const toolUseIds = blocks(messages[i].content)
      .filter((block) => block.type === 'tool_use')
      .map((block) => block.id);
    if (toolUseIds.length === 0) continue;

    const next = messages[i + 1];
    expect(next, 'a tool_use turn must be followed by its results').toBeDefined();
    expect(next.role).toBe('user');
    const resultIds = blocks(next.content)
      .filter((block) => block.type === 'tool_result')
      .map((block) => block.tool_use_id);
    expect(resultIds).toEqual(toolUseIds);
  }
}

beforeEach(() => {
  mocks.create.mockReset();
  mocks.sent.length = 0;
});

describe('Anthropic history for a single tool', () => {
  it('records one assistant turn and one results turn', async () => {
    const { agent, clipId } = harness();
    agent.configure(CONFIG);
    mocks.create
      .mockResolvedValueOnce(toolTurn([{ id: 't1', name: 'split_clip', input: { clipId, atFrame: 30 } }], 'Splitting.'))
      .mockResolvedValueOnce(textTurn('Done.'));

    const { callbacks, log } = recorder();
    await agent.chat('split it', callbacks);

    expect(log.error).toBeNull();
    expect(log.completed).toBe('Splitting.Done.');
    const second = sentRounds()[1];
    expectWellFormed(second);
    expect(second.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });
});

describe('Anthropic history for several tools in one response', () => {
  it('answers every tool_use in the one following user turn', async () => {
    const { agent, clipId } = harness();
    agent.configure(CONFIG);
    mocks.create
      .mockResolvedValueOnce(toolTurn([
        { id: 't1', name: 'get_timeline', input: {} },
        { id: 't2', name: 'split_clip', input: { clipId, atFrame: 30 } },
        { id: 't3', name: 'set_playhead', input: { frame: 10 } },
      ], 'Working.'))
      .mockResolvedValueOnce(textTurn('All done.'));

    const { callbacks, log } = recorder();
    await agent.chat('do three things', callbacks);

    expect(log.error).toBeNull();
    expect(log.toolCalls).toEqual(['get_timeline', 'split_clip', 'set_playhead']);

    const second = sentRounds()[1];
    expectWellFormed(second);

    // The defect this covers: the assistant turn used to be recorded once per
    // tool, so this was ['user','assistant','user','assistant','user','assistant','user'].
    expect(second.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);

    const assistant = blocks(second[1].content);
    expect(assistant.filter((block) => block.type === 'tool_use')).toHaveLength(3);
    const results = blocks(second[2].content);
    expect(results.map((block) => block.tool_use_id)).toEqual(['t1', 't2', 't3']);
  });

  it('does not record the assistant turn more than once', async () => {
    const { agent, clipId } = harness();
    agent.configure(CONFIG);
    mocks.create
      .mockResolvedValueOnce(toolTurn([
        { id: 't1', name: 'split_clip', input: { clipId, atFrame: 30 } },
        { id: 't2', name: 'split_clip', input: { clipId, atFrame: 60 } },
      ]))
      .mockResolvedValueOnce(textTurn('Done.'));

    await agent.chat('split twice', recorder().callbacks);

    const second = sentRounds()[1];
    expect(second.filter((m) => m.role === 'assistant')).toHaveLength(1);
  });

  it('replays block kinds it does not understand rather than dropping them', async () => {
    const { agent } = harness();
    agent.configure(CONFIG);
    mocks.create
      .mockResolvedValueOnce({
        content: [
          { type: 'thinking', thinking: 'internal' },
          { type: 'tool_use', id: 't1', name: 'get_timeline', input: {} },
        ],
        stop_reason: 'tool_use',
      })
      .mockResolvedValueOnce(textTurn('Done.'));

    await agent.chat('think then look', recorder().callbacks);

    const assistant = blocks(sentRounds()[1][1].content);
    // Dropping a thinking block invalidates the signature Anthropic checks.
    expect(assistant.map((block) => block.type)).toEqual(['thinking', 'tool_use']);
  });
});

describe('Anthropic history across several turns', () => {
  it('keeps roles alternating over many rounds of tools', async () => {
    const { agent, clipId } = harness();
    agent.configure(CONFIG);
    for (let round = 0; round < 4; round += 1) {
      mocks.create.mockResolvedValueOnce(toolTurn([
        { id: `a${round}`, name: 'get_timeline', input: {} },
        { id: `b${round}`, name: 'set_playhead', input: { frame: round } },
      ]));
    }
    mocks.create.mockResolvedValue(textTurn('Finished.'));

    const { callbacks, log } = recorder();
    await agent.chat(`tidy up ${clipId}`, callbacks);

    expect(log.error).toBeNull();
    expect(log.completed).toBe('Finished.');
    for (const messages of sentRounds()) expectWellFormed(messages);
  });

  it('carries a second user message without breaking alternation', async () => {
    const { agent } = harness();
    agent.configure(CONFIG);
    mocks.create
      .mockResolvedValueOnce(toolTurn([{ id: 't1', name: 'get_timeline', input: {} }]))
      .mockResolvedValueOnce(textTurn('First answer.'))
      .mockResolvedValueOnce(textTurn('Second answer.'));

    await agent.chat('one', recorder().callbacks);
    await agent.chat('two', recorder().callbacks);

    expectWellFormed(sentRounds()[2]);
  });
});

describe('Anthropic history when a turn is stopped', () => {
  it('answers the tools it did not run so the conversation stays usable', async () => {
    const { agent, clipId } = harness();
    agent.configure(CONFIG);
    mocks.create
      .mockResolvedValueOnce(toolTurn([
        { id: 't1', name: 'split_clip', input: { clipId, atFrame: 30 } },
        { id: 't2', name: 'split_clip', input: { clipId, atFrame: 60 } },
        { id: 't3', name: 'split_clip', input: { clipId, atFrame: 90 } },
      ], 'Cutting.'))
      .mockResolvedValueOnce(textTurn('Next answer.'));

    const { callbacks, log } = recorder();
    const stopAfterFirst = callbacks.onToolResult;
    callbacks.onToolResult = (name, result) => {
      stopAfterFirst(name, result);
      agent.cancel();
    };

    await agent.chat('cut three times', callbacks);
    expect(log.cancelled).toBe('Cutting.');
    expect(log.error).toBeNull();
    expect(log.toolCalls).toEqual(['split_clip']);

    // The next message has to work: an unanswered tool_use would make every
    // later request in this conversation fail.
    await agent.chat('carry on', recorder().callbacks);

    const messages = sentRounds()[1];
    expectWellFormed(messages);
    const results = blocks(messages[2].content).filter((block) => block.type === 'tool_result');
    expect(results.map((block) => block.tool_use_id)).toEqual(['t1', 't2', 't3']);
    expect(results.filter((block) => block.is_error)).toHaveLength(2);
  });

  it('joins a later message to the trailing results turn', async () => {
    const { agent, clipId } = harness();
    agent.configure(CONFIG);
    mocks.create
      .mockResolvedValueOnce(toolTurn([{ id: 't1', name: 'split_clip', input: { clipId, atFrame: 30 } }]))
      .mockResolvedValueOnce(textTurn('Next answer.'));

    const { callbacks } = recorder();
    const stop = callbacks.onToolResult;
    callbacks.onToolResult = (name, result) => { stop(name, result); agent.cancel(); };
    await agent.chat('cut', callbacks);

    await agent.chat('and now trim the head', recorder().callbacks);

    const messages = sentRounds()[1];
    expectWellFormed(messages);
    // Appended to the existing user turn rather than added as a second one.
    expect(messages).toHaveLength(3);
    const trailing = blocks(messages[2].content);
    expect(trailing.at(-1)).toMatchObject({ type: 'text', text: 'and now trim the head' });
  });
});

describe('Anthropic round limit', () => {
  it('stops at the cap and still leaves the conversation usable', async () => {
    const { agent } = harness();
    agent.configure(CONFIG);
    // Always asks for another tool; without a bound this never returns.
    mocks.create.mockResolvedValue(toolTurn([{ id: 't', name: 'get_timeline', input: {} }]));

    const { callbacks, log } = recorder();
    await agent.chat('go', callbacks);

    expect(log.error).toMatch(/tool rounds/i);
    expect(mocks.create).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS);

    mocks.create.mockResolvedValue(textTurn('Fresh answer.'));
    const next = recorder();
    await agent.chat('try something smaller', next.callbacks);

    expect(next.log.error).toBeNull();
    expectWellFormed(sentRounds().at(-1)!);
  });
});
