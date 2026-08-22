/**
 * Regression coverage for the OpenAI-compatible transport (upstream #17, #140).
 *
 * The endpoint is user-configured, so its responses are untrusted input: a
 * missing field, a malformed tool-argument string, or an HTML error page must
 * produce a clear failure rather than a crash inside property access. The tests
 * also pin down that no API key is sent when none is configured, which is what
 * makes local runtimes work.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  DEFAULT_TIMEOUT_MS,
  CancelledError,
  createCompletion,
  parseCompletion,
  parseToolArguments,
  toOpenAiTools,
  type CompletionRequest,
} from './openai-compatible';

function request(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    baseUrl: 'https://api.test/v1',
    apiKey: 'sk-secret-key',
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    maxTokens: 256,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const spy = vi.fn(impl);
  vi.stubGlobal('fetch', spy as unknown as typeof fetch);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('toOpenAiTools', () => {
  it('wraps each schema in the function-calling envelope', () => {
    const tools = toOpenAiTools([
      {
        name: 'split_clip',
        description: 'Split a clip.',
        inputSchema: {
          type: 'object',
          properties: { clipId: { type: 'string' } },
          required: ['clipId'],
        },
      },
    ]);

    expect(tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'split_clip',
          description: 'Split a clip.',
          parameters: {
            type: 'object',
            properties: { clipId: { type: 'string' } },
            required: ['clipId'],
          },
          strict: false,
        },
      },
    ]);
  });

  it('always supplies a properties object, which some providers require', () => {
    const [tool] = toOpenAiTools([
      { name: 'undo', description: 'Undo.', inputSchema: { type: 'object' } },
    ]);
    expect(tool.function.parameters).toEqual({ type: 'object', properties: {} });
  });

  it('pins every tool non-strict so omitted arguments stay omitted (#471)', () => {
    // Upstream's Responses API defect: under strict schema normalization the
    // model is forced to emit every property, so an optional argument it meant
    // to omit arrived as an explicit null instead of being absent. The request
    // must declare each tool non-strict.
    const tools = toOpenAiTools([
      { name: 'remove_silence', description: 'A.', inputSchema: { type: 'object' } },
      { name: 'trim_clip', description: 'B.', inputSchema: { type: 'object' } },
    ]);
    expect(tools.map((tool) => tool.function.strict)).toEqual([false, false]);
  });
});

describe('parseToolArguments', () => {
  it('parses a normal argument object', () => {
    expect(parseToolArguments('{"clipId":"a","frame":30}')).toEqual({ clipId: 'a', frame: 30 });
  });

  it('treats anything that is not an object as no arguments', () => {
    // The executor validates each field; an empty object yields a clean
    // validation error instead of a throw on property access.
    for (const raw of ['', '   ', 'not json', '[1,2]', '"text"', '42', 'null', '{']) {
      expect(parseToolArguments(raw), raw).toEqual({});
    }
  });

  it('drops keys sent as explicit null so omission keeps its meaning (#471)', () => {
    // Every tool schema expresses optionality with optional(), so a null can
    // only be a provider artifact for "the model omitted this". It must reach
    // the executor as absent — e.g. remove_silence treats an omitted argument
    // as "follow the saved controls" — not as a validation failure.
    expect(parseToolArguments('{"clipId":null,"thresholdDb":-35}')).toEqual({
      thresholdDb: -35,
    });
    expect(parseToolArguments('{"a":null,"b":null}')).toEqual({});
  });

  it('leaves nested objects untouched', () => {
    // Only top-level keys are normalized; deeper stripping could mask a
    // provider actually sending malformed structure.
    expect(parseToolArguments('{"opts":{"x":null},"n":1}')).toEqual({ opts: { x: null }, n: 1 });
  });
});

describe('parseCompletion', () => {
  it('reads assistant text', () => {
    const result = parseCompletion({ choices: [{ message: { content: 'hello' } }] });
    expect(result).toEqual({ content: 'hello', toolCalls: [], wantsTools: false });
  });

  it('reads tool calls', () => {
    const result = parseCompletion({
      choices: [{
        message: {
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'get_timeline', arguments: '{}' } },
          ],
        },
      }],
    });

    expect(result.wantsTools).toBe(true);
    expect(result.content).toBe('');
    expect(result.toolCalls).toEqual([
      { id: 'call_1', name: 'get_timeline', argumentsJson: '{}' },
    ]);
  });

  it('keeps text that accompanies a tool call', () => {
    const result = parseCompletion({
      choices: [{
        message: {
          content: 'Let me look.',
          tool_calls: [{ id: 'c', function: { name: 'get_timeline', arguments: '{}' } }],
        },
      }],
    });
    expect(result.content).toBe('Let me look.');
    expect(result.wantsTools).toBe(true);
  });

  it('substitutes an id when the endpoint omits one', () => {
    const result = parseCompletion({
      choices: [{ message: { tool_calls: [{ function: { name: 'undo' } }] } }],
    });
    expect(result.toolCalls[0].id).toBe('call_0');
    expect(result.toolCalls[0].argumentsJson).toBe('');
  });

  it('skips tool calls with no usable name', () => {
    const result = parseCompletion({
      choices: [{
        message: {
          tool_calls: [
            { id: 'a', function: { name: '' } },
            { id: 'b', function: {} },
            { id: 'c' },
            { id: 'd', function: { name: 'undo', arguments: '{}' } },
          ],
        },
      }],
    });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('undo');
  });

  it('throws a clear error when there is no completion at all', () => {
    for (const payload of [{}, { choices: [] }, { choices: [{}] }, null, undefined, 'text', 42]) {
      expect(() => parseCompletion(payload)).toThrow(/no completion choices/i);
    }
  });

  it('ignores a non-array tool_calls field', () => {
    const result = parseCompletion({
      choices: [{ message: { content: 'ok', tool_calls: 'nope' } }],
    });
    expect(result.wantsTools).toBe(false);
  });
});

describe('createCompletion', () => {
  it('posts to /chat/completions under the configured base URL', async () => {
    const spy = stubFetch(async () => jsonResponse({ choices: [{ message: { content: 'ok' } }] }));

    const result = await createCompletion(request({ baseUrl: 'https://api.test/v1/' }));

    expect(result.content).toBe('ok');
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('https://api.test/v1/chat/completions');
    expect(init.method).toBe('POST');
  });

  it('sends the key as a bearer token', async () => {
    const spy = stubFetch(async () => jsonResponse({ choices: [{ message: { content: '' } }] }));
    await createCompletion(request());

    const headers = spy.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-secret-key');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('omits the Authorization header when no key is configured', async () => {
    // Some local runtimes reject a request carrying an empty bearer token.
    const spy = stubFetch(async () => jsonResponse({ choices: [{ message: { content: '' } }] }));
    await createCompletion(request({ apiKey: '' }));

    const headers = spy.mock.calls[0][1].headers as Record<string, string>;
    expect('Authorization' in headers).toBe(false);
  });

  it('includes tools only when some are supplied', async () => {
    const spy = stubFetch(async () => jsonResponse({ choices: [{ message: { content: '' } }] }));

    await createCompletion(request());
    expect(JSON.parse(spy.mock.calls[0][1].body as string)).not.toHaveProperty('tools');

    await createCompletion(request({
      tools: [{
        type: 'function',
        function: { name: 'undo', description: 'Undo.', parameters: { type: 'object' }, strict: false },
      }],
    }));
    const body = JSON.parse(spy.mock.calls[1][1].body as string);
    expect(body.tools).toHaveLength(1);
    expect(body.tool_choice).toBe('auto');
  });

  it('sends the model, token budget, and messages', async () => {
    const spy = stubFetch(async () => jsonResponse({ choices: [{ message: { content: '' } }] }));
    await createCompletion(request({ model: 'llama3.1', maxTokens: 999 }));

    const body = JSON.parse(spy.mock.calls[0][1].body as string);
    expect(body.model).toBe('llama3.1');
    expect(body.max_tokens).toBe(999);
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  describe('failure reporting', () => {
    it('names an authentication failure without echoing the key', async () => {
      stubFetch(async () => jsonResponse({ error: { message: 'bad key' } }, 401));
      await expect(createCompletion(request())).rejects.toThrow(/rejected the API key/i);
      await expect(createCompletion(request())).rejects.not.toThrow(/sk-secret-key/);
    });

    it('points at the base URL on a 404', async () => {
      stubFetch(async () => jsonResponse({}, 404));
      await expect(createCompletion(request())).rejects.toThrow(/base URL/i);
    });

    it('names rate limiting', async () => {
      stubFetch(async () => jsonResponse({}, 429));
      await expect(createCompletion(request())).rejects.toThrow(/rate limit/i);
    });

    it('surfaces the provider message for other statuses', async () => {
      stubFetch(async () => jsonResponse({ error: { message: 'model not found' } }, 400));
      await expect(createCompletion(request())).rejects.toThrow(/400.*model not found/i);
    });

    it('handles an error body that is not JSON', async () => {
      stubFetch(async () => new Response('<html>gateway error</html>', { status: 502 }));
      await expect(createCompletion(request())).rejects.toThrow(/502/);
    });

    it('reports a success response whose body is not JSON', async () => {
      stubFetch(async () => new Response('<html>hi</html>', { status: 200 }));
      await expect(createCompletion(request())).rejects.toThrow(/not JSON/i);
    });

    it('names the host when the endpoint is unreachable', async () => {
      // fetch surfaces DNS and TLS failures as an opaque TypeError.
      stubFetch(async () => {
        throw new TypeError('fetch failed');
      });
      await expect(createCompletion(request())).rejects.toThrow(/api\.test/);
      await expect(createCompletion(request())).rejects.toThrow(/server is running/i);
    });

    it('reports a timeout in seconds', async () => {
      stubFetch(async (_url, init) => {
        const signal = init.signal as AbortSignal;
        return await new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        });
      });

      await expect(createCompletion(request({ timeoutMs: 20 })))
        .rejects.toThrow(/did not respond within/i);
    });

    it('has a bounded default timeout', () => {
      expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
      expect(Number.isFinite(DEFAULT_TIMEOUT_MS)).toBe(true);
    });
  });

  describe('cancellation (#58)', () => {
    /** A fetch that only settles when its request is aborted. */
    function stubHangingFetch(): void {
      stubFetch(async (_url, init) => await new Promise<Response>((_resolve, reject) => {
        (init.signal as AbortSignal).addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      }));
    }

    it('reports a user stop distinctly from a timeout', async () => {
      stubHangingFetch();
      const controller = new AbortController();
      const pending = createCompletion(request({ signal: controller.signal, timeoutMs: 60_000 }));
      controller.abort();

      // Both arrive as the same AbortError from fetch. Conflating them would put
      // "the endpoint did not respond" in the transcript after the user pressed
      // Stop, which reads as a fault the user did not cause.
      await expect(pending).rejects.toBeInstanceOf(CancelledError);
      await expect(pending).rejects.not.toThrow(/did not respond/i);
    });

    it('still reports a timeout when the caller has not stopped anything', async () => {
      stubHangingFetch();
      const controller = new AbortController();

      await expect(createCompletion(request({ signal: controller.signal, timeoutMs: 20 })))
        .rejects.toThrow(/did not respond within/i);
    });

    it('refuses an already-stopped request without contacting the endpoint', async () => {
      const spy = vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'hi' } }] }));
      vi.stubGlobal('fetch', spy as unknown as typeof fetch);
      const controller = new AbortController();
      controller.abort();

      await expect(createCompletion(request({ signal: controller.signal })))
        .rejects.toBeInstanceOf(CancelledError);
      expect(spy).not.toHaveBeenCalled();
    });

    it('does not accumulate abort listeners across a long conversation', async () => {
      stubFetch(async () => jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
      const { signal } = new AbortController();

      // Counted on the signal itself rather than read out of Node internals, so
      // the assertion is about this code's own balance of add and remove.
      let added = 0;
      let removed = 0;
      const realAdd = signal.addEventListener.bind(signal);
      const realRemove = signal.removeEventListener.bind(signal);
      signal.addEventListener = ((...args: Parameters<typeof realAdd>) => {
        added += 1;
        return realAdd(...args);
      }) as typeof signal.addEventListener;
      signal.removeEventListener = ((...args: Parameters<typeof realRemove>) => {
        removed += 1;
        return realRemove(...args);
      }) as typeof signal.removeEventListener;

      const rounds = 20;
      for (let i = 0; i < rounds; i += 1) {
        await createCompletion(request({ signal }));
      }

      // The signal outlives each request, so a listener left behind per round
      // would grow without bound across a long session.
      expect(added).toBe(rounds);
      expect(removed).toBe(rounds);
    });
  });
});
