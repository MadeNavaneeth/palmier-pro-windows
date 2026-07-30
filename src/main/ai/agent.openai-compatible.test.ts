/**
 * Regression coverage for the OpenAI-compatible agent turn (upstream #17, #140).
 *
 * The behaviour that matters end to end: an OpenAI-compatible endpoint drives the
 * same ToolExecutor as the Anthropic path so edits mean the same thing, the
 * assistant turn that requested a tool is replayed with its tool_calls intact
 * (otherwise the follow-up tool messages have nothing to attach to), and the
 * tool loop is bounded so a model that always asks for a tool cannot edit the
 * timeline indefinitely.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { EditorController } from '../../shared/editor/controller';
import { PalmierAgent, MAX_TOOL_ROUNDS, type StreamCallbacks } from './agent';

interface Recorded {
  tokens: string[];
  toolCalls: { name: string; args: Record<string, unknown> }[];
  toolResults: { name: string; result: unknown }[];
  completed: string | null;
  error: string | null;
  cancelled: string | null;
}

function recorder(): { callbacks: StreamCallbacks; log: Recorded } {
  const log: Recorded = {
    tokens: [],
    toolCalls: [],
    toolResults: [],
    completed: null,
    error: null,
    cancelled: null,
  };
  return {
    log,
    callbacks: {
      onToken: (token) => log.tokens.push(token),
      onToolCall: (name, args) => log.toolCalls.push({ name, args }),
      onToolResult: (name, result) => log.toolResults.push({ name, result }),
      onComplete: (full) => {
        log.completed = full;
      },
      onError: (error) => {
        log.error = error;
      },
      onCancelled: (partial) => {
        log.cancelled = partial;
      },
    },
  };
}

/** Controller holding one clip on v1, so a split has something to act on. */
function controllerWithClip(): { controller: EditorController; clipId: string } {
  const controller = new EditorController();
  controller.addMedia({
    id: 'asset',
    path: 'C:\\media\\clip.mp4',
    filename: 'clip.mp4',
    type: 'video',
    duration: 300,
    fileSize: 100,
    addedAt: '2026-07-25T00:00:00.000Z',
  });
  const clipId = controller.addClip({
    assetId: 'asset',
    trackId: 'v1',
    startFrame: 0,
    durationFrames: 60,
  });
  return { controller, clipId };
}

function textResponse(content: string) {
  return { choices: [{ message: { content } }] };
}

function toolResponse(
  calls: { id: string; name: string; args: unknown }[],
  content: string | null = null,
) {
  return {
    choices: [{
      message: {
        content,
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        })),
      },
    }],
  };
}

/** The request fields these tests inspect, as they appear on the wire. */
interface SentMessage {
  role: string;
  content?: string | null;
  tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

interface SentBody {
  model: string;
  max_tokens: number;
  messages: SentMessage[];
  tools?: unknown[];
  tool_choice?: string;
}

/** Serve a scripted sequence of responses and capture every request body. */
function stubFetchSequence(payloads: unknown[]) {
  const bodies: SentBody[] = [];
  let index = 0;
  const spy = vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string));
    const payload = payloads[Math.min(index, payloads.length - 1)];
    index += 1;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', spy as unknown as typeof fetch);
  return { bodies, spy };
}

const CONFIG = {
  provider: 'openai-compatible' as const,
  apiKey: 'sk-test',
  baseUrl: 'https://api.test/v1',
  model: 'gpt-4o',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('configuration', () => {
  it('refuses to chat before it is configured', async () => {
    const { controller } = controllerWithClip();
    const agent = new PalmierAgent(controller);
    const { callbacks, log } = recorder();

    await agent.chat('hello', callbacks);
    expect(log.error).toMatch(/not configured/i);
  });

  it('requires a base URL for an OpenAI-compatible provider', async () => {
    const { controller } = controllerWithClip();
    const agent = new PalmierAgent(controller);
    agent.configure({ provider: 'openai-compatible', apiKey: 'sk-test', model: 'gpt-4o' });
    const { callbacks, log } = recorder();

    await agent.chat('hello', callbacks);
    expect(log.error).toMatch(/base URL/i);
  });

  it('requires a model name', async () => {
    const { controller } = controllerWithClip();
    const agent = new PalmierAgent(controller);
    agent.configure({ ...CONFIG, model: '' });
    const { callbacks, log } = recorder();

    await agent.chat('hello', callbacks);
    expect(log.error).toMatch(/model name/i);
  });

  it('counts a keyless local endpoint as configured', () => {
    const { controller } = controllerWithClip();
    const agent = new PalmierAgent(controller);
    agent.configure({
      provider: 'openai-compatible',
      apiKey: '',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'llama3.1',
    });
    expect(agent.isConfigured()).toBe(true);
  });
});

describe('plain text turn', () => {
  it('streams the answer and completes', async () => {
    const { controller } = controllerWithClip();
    const { bodies } = stubFetchSequence([textResponse('Here is the plan.')]);
    const agent = new PalmierAgent(controller);
    agent.configure(CONFIG);
    const { callbacks, log } = recorder();

    await agent.chat('what next?', callbacks);

    expect(log.error).toBeNull();
    expect(log.completed).toBe('Here is the plan.');
    expect(log.tokens).toEqual(['Here is the plan.']);
    // The system prompt leads, then the user turn.
    expect(bodies[0].messages[0].role).toBe('system');
    expect(bodies[0].messages.at(-1)).toEqual({ role: 'user', content: 'what next?' });
  });

  it('carries prior turns into the next request', async () => {
    const { controller } = controllerWithClip();
    const { bodies } = stubFetchSequence([textResponse('first'), textResponse('second')]);
    const agent = new PalmierAgent(controller);
    agent.configure(CONFIG);

    await agent.chat('one', recorder().callbacks);
    await agent.chat('two', recorder().callbacks);

    const roles = bodies[1].messages.map((m) => `${m.role}:${m.content}`);
    expect(roles).toContain('user:one');
    expect(roles).toContain('assistant:first');
    expect(roles).toContain('user:two');
  });

  it('drops history when asked', async () => {
    const { controller } = controllerWithClip();
    const { bodies } = stubFetchSequence([textResponse('first'), textResponse('second')]);
    const agent = new PalmierAgent(controller);
    agent.configure(CONFIG);

    await agent.chat('one', recorder().callbacks);
    agent.clearHistory();
    await agent.chat('two', recorder().callbacks);

    expect(bodies[1].messages).toHaveLength(2); // system + the new user turn
  });
});

describe('tool calls', () => {
  it('executes the tool against the shared controller and finishes the turn', async () => {
    const { controller, clipId } = controllerWithClip();
    const { bodies } = stubFetchSequence([
      toolResponse([{ id: 'call_1', name: 'split_clip', args: { clipId, atFrame: 30 } }], 'Splitting.'),
      textResponse('Done.'),
    ]);
    const agent = new PalmierAgent(controller);
    agent.configure(CONFIG);
    const { callbacks, log } = recorder();

    await agent.chat('split it at 30', callbacks);

    expect(log.error).toBeNull();
    // Same ToolExecutor as the Anthropic path and MCP: the edit really happened.
    expect(controller.getClips()).toHaveLength(2);
    expect(log.toolCalls).toEqual([
      { name: 'split_clip', args: { clipId, atFrame: 30 } },
    ]);
    expect(log.toolResults).toHaveLength(1);
    expect(log.completed).toBe('Splitting.Done.');

    // Round two replays the requesting assistant turn plus the tool result.
    const second = bodies[1].messages;
    const assistant = second.find((m) => m.role === 'assistant' && m.tool_calls);
    expect(assistant?.tool_calls?.[0].id).toBe('call_1');
    expect(assistant?.tool_calls?.[0].function.name).toBe('split_clip');
    const toolMessage = second.find((m) => m.role === 'tool');
    expect(toolMessage?.tool_call_id).toBe('call_1');
    expect(typeof toolMessage?.content).toBe('string');
  });

  it('leaves the edit undoable', async () => {
    const { controller, clipId } = controllerWithClip();
    stubFetchSequence([
      toolResponse([{ id: 'c', name: 'split_clip', args: { clipId, atFrame: 30 } }]),
      textResponse('Done.'),
    ]);
    const agent = new PalmierAgent(controller);
    agent.configure(CONFIG);

    await agent.chat('split', recorder().callbacks);
    expect(controller.getClips()).toHaveLength(2);

    controller.undo();
    expect(controller.getClips()).toHaveLength(1);
  });

  it('runs several tool calls from one response in order', async () => {
    const { controller, clipId } = controllerWithClip();
    stubFetchSequence([
      toolResponse([
        { id: 'c1', name: 'get_timeline', args: {} },
        { id: 'c2', name: 'split_clip', args: { clipId, atFrame: 30 } },
      ]),
      textResponse('Done.'),
    ]);
    const agent = new PalmierAgent(controller);
    agent.configure(CONFIG);
    const { callbacks, log } = recorder();

    await agent.chat('inspect then split', callbacks);

    expect(log.toolCalls.map((call) => call.name)).toEqual(['get_timeline', 'split_clip']);
    expect(log.toolResults).toHaveLength(2);
  });

  it('reports a failing tool without aborting the turn', async () => {
    const { controller } = controllerWithClip();
    stubFetchSequence([
      toolResponse([{ id: 'c', name: 'split_clip', args: { clipId: 'missing', atFrame: 30 } }]),
      textResponse('That clip does not exist.'),
    ]);
    const agent = new PalmierAgent(controller);
    agent.configure(CONFIG);
    const { callbacks, log } = recorder();

    await agent.chat('split a clip that is not there', callbacks);

    expect(log.error).toBeNull();
    expect(log.toolResults).toHaveLength(1);
    expect(log.completed).toBe('That clip does not exist.');
  });

  it('stops after the round limit instead of looping forever', async () => {
    const { controller, clipId } = controllerWithClip();
    // Always asks for another tool; without a bound this never returns.
    const { spy } = stubFetchSequence([
      toolResponse([{ id: 'c', name: 'get_timeline', args: { clipId } }]),
    ]);
    const agent = new PalmierAgent(controller);
    agent.configure(CONFIG);
    const { callbacks, log } = recorder();

    await agent.chat('go', callbacks);

    expect(log.error).toMatch(/tool rounds/i);
    expect(log.completed).toBeNull();
    expect(spy).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS);
  });
});

/**
 * A fetch that hangs until the request is aborted, so a turn can be stopped
 * while it is genuinely in flight rather than between rounds.
 */
function stubFetchHangs(): { spy: ReturnType<typeof vi.fn>; requested: Promise<void> } {
  let markRequested!: () => void;
  const requested = new Promise<void>((resolve) => {
    markRequested = resolve;
  });

  const spy = vi.fn((_url: string, init: RequestInit) => {
    markRequested();
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => {
        // What fetch itself throws on abort, so the transport's own handling is
        // what gets exercised.
        const err = new Error('The operation was aborted.');
        err.name = 'AbortError';
        reject(err);
      };
      if (init.signal?.aborted) abort();
      else init.signal?.addEventListener('abort', abort, { once: true });
    });
  });
  vi.stubGlobal('fetch', spy as unknown as typeof fetch);
  return { spy, requested };
}

describe('cancelling a turn (#58)', () => {
  it('reports nothing to cancel when idle', () => {
    const { controller } = controllerWithClip();
    const agent = new PalmierAgent(controller);

    expect(agent.isBusy()).toBe(false);
    expect(agent.cancel()).toBe(false);
  });

  it('stops a request that is still in flight without reporting an error', async () => {
    const { controller } = controllerWithClip();
    const { requested } = stubFetchHangs();
    const agent = new PalmierAgent(controller);
    agent.configure(CONFIG);
    const { callbacks, log } = recorder();

    const turn = agent.chat('go', callbacks);
    await requested;
    expect(agent.isBusy()).toBe(true);
    expect(agent.cancel()).toBe(true);
    await turn;

    // A stop is not a failure: no error text, and the panel is not told the turn
    // completed with an answer it never produced.
    expect(log.cancelled).toBe('');
    expect(log.error).toBeNull();
    expect(log.completed).toBeNull();
  });

  it('releases the turn so the next message can be sent', async () => {
    const { controller } = controllerWithClip();
    const { requested } = stubFetchHangs();
    const agent = new PalmierAgent(controller);
    agent.configure(CONFIG);

    const turn = agent.chat('go', recorder().callbacks);
    await requested;
    agent.cancel();
    await turn;

    expect(agent.isBusy()).toBe(false);

    stubFetchSequence([textResponse('Second answer.')]);
    const { callbacks, log } = recorder();
    await agent.chat('again', callbacks);
    expect(log.completed).toBe('Second answer.');
  });

  it('refuses a second turn while one is running instead of interleaving them', async () => {
    const { controller } = controllerWithClip();
    const { requested } = stubFetchHangs();
    const agent = new PalmierAgent(controller);
    agent.configure(CONFIG);

    const first = agent.chat('one', recorder().callbacks);
    await requested;

    const { callbacks, log } = recorder();
    await agent.chat('two', callbacks);
    expect(log.error).toMatch(/already running/i);

    agent.cancel();
    await first;
  });

  it('does not run the remaining tools of an interrupted batch', async () => {
    const { controller, clipId } = controllerWithClip();
    stubFetchSequence([
      toolResponse([
        { id: 'c1', name: 'split_clip', args: { clipId, atFrame: 30 } },
        { id: 'c2', name: 'split_clip', args: { clipId, atFrame: 45 } },
      ]),
      textResponse('Done.'),
    ]);
    const agent = new PalmierAgent(controller);
    agent.configure(CONFIG);
    const { callbacks, log } = recorder();

    // Stop as soon as the first edit lands, which is the realistic case: the
    // user sees an edit they did not want and hits Stop.
    const recordResult = callbacks.onToolResult;
    callbacks.onToolResult = (name, result) => {
      recordResult(name, result);
      agent.cancel();
    };

    await agent.chat('split twice', callbacks);

    expect(log.toolCalls).toHaveLength(1);
    expect(log.cancelled).not.toBeNull();
    expect(log.error).toBeNull();
    // The edit that already ran stays, and stays undoable: a stop interrupts, it
    // does not roll back.
    expect(controller.getClips()).toHaveLength(2);
    expect(controller.canUndo()).toBe(true);
  });

  it('keeps the partial answer in history but no orphaned tool call', async () => {
    const { controller } = controllerWithClip();
    const { bodies } = stubFetchSequence([
      toolResponse([{ id: 'c1', name: 'get_timeline', args: {} }], 'Looking at the timeline.'),
      textResponse('Next answer.'),
    ]);
    const agent = new PalmierAgent(controller);
    agent.configure(CONFIG);
    const { callbacks } = recorder();
    const recordResult = callbacks.onToolResult;
    callbacks.onToolResult = (name, result) => {
      recordResult(name, result);
      agent.cancel();
    };

    await agent.chat('inspect', callbacks);
    await agent.chat('carry on', recorder().callbacks);

    const replayed = bodies[1].messages;
    expect(replayed.map((m) => `${m.role}:${m.content}`)).toContain(
      'assistant:Looking at the timeline.',
    );
    // An assistant tool call without a matching result is what providers reject,
    // so an interrupted turn must not leave one behind.
    expect(replayed.some((m) => m.tool_calls)).toBe(false);
    expect(replayed.some((m) => m.role === 'tool')).toBe(false);
  });

  it('clearing history stops a turn that is still running', async () => {
    const { controller } = controllerWithClip();
    const { requested } = stubFetchHangs();
    const agent = new PalmierAgent(controller);
    agent.configure(CONFIG);
    const { callbacks, log } = recorder();

    const turn = agent.chat('go', callbacks);
    await requested;
    agent.clearHistory();
    await turn;

    expect(log.cancelled).toBe('');
    expect(agent.isBusy()).toBe(false);
  });
});

describe('transport failures', () => {
  it('surfaces an endpoint error through onError', async () => {
    const { controller } = controllerWithClip();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({}), { status: 401 })) as unknown as typeof fetch,
    );
    const agent = new PalmierAgent(controller);
    agent.configure(CONFIG);
    const { callbacks, log } = recorder();

    await agent.chat('hello', callbacks);

    expect(log.error).toMatch(/API key/i);
    expect(log.error).not.toMatch(/sk-test/);
    expect(log.completed).toBeNull();
  });

  it('does not leave the timeline half-edited when the follow-up call fails', async () => {
    const { controller, clipId } = controllerWithClip();
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call += 1;
        if (call === 1) {
          return new Response(
            JSON.stringify(toolResponse([{ id: 'c', name: 'split_clip', args: { clipId, atFrame: 30 } }])),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({}), { status: 500 });
      }) as unknown as typeof fetch,
    );
    const agent = new PalmierAgent(controller);
    agent.configure(CONFIG);
    const { callbacks, log } = recorder();

    await agent.chat('split', callbacks);

    expect(log.error).toMatch(/500/);
    // The split already ran and stays undoable; it is not silently rolled back.
    expect(controller.getClips()).toHaveLength(2);
    expect(controller.canUndo()).toBe(true);
  });
});
