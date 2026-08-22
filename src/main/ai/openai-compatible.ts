/**
 * OpenAI-compatible chat transport (upstream issues #17 and #140).
 *
 * Talks the `/chat/completions` dialect directly over `fetch` rather than adding
 * a vendor SDK: the surface actually needed is one POST plus tool-call plumbing,
 * and every provider worth supporting (OpenAI, OpenRouter, Groq, Together,
 * Ollama, LM Studio) speaks it. A second SDK would add a dependency and still
 * not cover the local runtimes.
 *
 * Nothing here logs the API key or the endpoint's response body.
 */

import { resolveEndpoint } from '../../shared/ai/provider-config';

/** Tool description in the shape this API expects. */
export interface OpenAiTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    /**
     * Pinned non-strict (upstream #471): strict schema normalization forces the
     * model to emit every property, so an optional argument the model meant to
     * omit arrives as an explicit `null` instead of being absent — and
     * "omitted" must stay distinguishable from a supplied value.
     */
    strict: false;
  };
}

export interface OpenAiToolCall {
  id: string;
  name: string;
  /** Raw JSON string from the model; the caller parses and validates it. */
  argumentsJson: string;
}

export type OpenAiMessage =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: {
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }[];
    }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface CompletionResult {
  /** Assistant text, empty when the turn was tool calls only. */
  content: string;
  toolCalls: OpenAiToolCall[];
  /** True when the model asked for tools and expects another round. */
  wantsTools: boolean;
}

export interface CompletionRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: OpenAiMessage[];
  tools: OpenAiTool[];
  maxTokens: number;
  /** Milliseconds before the request is aborted. */
  timeoutMs?: number;
  /** Aborts the request when the user stops the turn (upstream #58). */
  signal?: AbortSignal;
}

/**
 * The user stopped the turn.
 *
 * Distinct from a timeout or a transport failure because it is not an error to
 * report: the caller unwinds quietly instead of putting a message in the
 * transcript that reads like something went wrong.
 */
export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancelledError';
  }
}

/**
 * Default request timeout.
 *
 * A local runtime loading a cold model is slow but not unbounded; without a
 * ceiling an unreachable endpoint leaves the chat spinning with no way back.
 */
export const DEFAULT_TIMEOUT_MS = 120_000;

/** Convert the editor's JSON-Schema tool list into function-calling format. */
export function toOpenAiTools(
  schemas: readonly { name: string; description: string; inputSchema: Record<string, unknown> }[],
): OpenAiTool[] {
  return schemas.map((schema) => ({
    type: 'function' as const,
    function: {
      name: schema.name,
      description: schema.description,
      // Some providers reject a schema without `properties`, so an empty object
      // is supplied rather than omitting the key.
      parameters: {
        type: 'object',
        properties: {},
        ...schema.inputSchema,
      },
      strict: false as const,
    },
  }));
}

/**
 * Parse tool arguments, treating malformed JSON as an empty argument set.
 *
 * Keys the model sent as explicit `null` are dropped before validation
 * (upstream #471): every tool schema expresses optionality with `optional()`,
 * so `null` can never be a meaningful value — it is what strict-normalizing
 * providers emit for an argument the model meant to omit. Dropping it here
 * keeps "omitted" meaning "use the default" (the silence-removal contract, the
 * optional clip targeting, and so on) instead of failing validation.
 * Nested objects are left untouched: the schemas are flat, and stripping
 * deeply could mask a provider actually sending malformed structure.
 */
export function parseToolArguments(argumentsJson: string): Record<string, unknown> {
  if (!argumentsJson || argumentsJson.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(argumentsJson);
    // A bare array or scalar is not a valid argument object; the executor
    // validates each field anyway, so an empty object produces a clean error
    // instead of a crash inside argument access.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const args: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === null) continue;
      args[key] = value;
    }
    return args;
  } catch {
    return {};
  }
}

/**
 * Read one completion out of an untrusted response body.
 *
 * The endpoint is user-configured and may not be a conforming implementation, so
 * every field is checked rather than asserted.
 */
export function parseCompletion(payload: unknown): CompletionResult {
  const choices = (payload as { choices?: unknown })?.choices;
  const first = Array.isArray(choices) ? choices[0] : undefined;
  const message = (first as { message?: unknown })?.message as
    | { content?: unknown; tool_calls?: unknown }
    | undefined;

  if (!message) {
    throw new Error('The endpoint returned no completion choices.');
  }

  const content = typeof message.content === 'string' ? message.content : '';

  const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const toolCalls: OpenAiToolCall[] = [];
  for (const raw of rawCalls) {
    const call = raw as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
    const name = call.function?.name;
    if (typeof name !== 'string' || name.length === 0) continue;
    toolCalls.push({
      id: typeof call.id === 'string' && call.id.length > 0 ? call.id : `call_${toolCalls.length}`,
      name,
      argumentsJson: typeof call.function?.arguments === 'string' ? call.function.arguments : '',
    });
  }

  return { content, toolCalls, wantsTools: toolCalls.length > 0 };
}

/** Turn a non-2xx response into a message that names the cause but no secrets. */
async function describeFailure(response: Response): Promise<string> {
  let detail = '';
  try {
    const text = await response.text();
    const parsed: unknown = JSON.parse(text);
    const message = (parsed as { error?: { message?: unknown } })?.error?.message;
    detail = typeof message === 'string' ? message : text.slice(0, 200);
  } catch {
    detail = '';
  }

  if (response.status === 401 || response.status === 403) {
    return 'The endpoint rejected the API key (401/403). Check the key and the provider.';
  }
  if (response.status === 404) {
    return 'The endpoint has no /chat/completions route (404). Check the base URL, including any /v1 suffix.';
  }
  if (response.status === 429) {
    return 'The provider is rate limiting this key (429). Try again shortly.';
  }
  return detail
    ? `The endpoint returned ${response.status}: ${detail}`
    : `The endpoint returned ${response.status}.`;
}

/** POST one chat completion. Throws with an actionable message on failure. */
export async function createCompletion(request: CompletionRequest): Promise<CompletionResult> {
  const endpoint = resolveEndpoint(request.baseUrl, '/chat/completions');
  if (request.signal?.aborted) throw new CancelledError();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  // One controller drives the fetch, fed by either the timeout or the user's
  // stop. Forwarding rather than passing the caller's signal straight through
  // keeps the timeout applicable in both cases, and the listener is removed in
  // `finally` so a long conversation does not accumulate them on a signal that
  // outlives the request.
  const forwardAbort = () => controller.abort();
  request.signal?.addEventListener('abort', forwardAbort, { once: true });

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    // Local runtimes accept requests with no key; sending an empty bearer token
    // makes some of them reject the call outright.
    if (request.apiKey.length > 0) headers.Authorization = `Bearer ${request.apiKey}`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: request.model,
        max_tokens: request.maxTokens,
        messages: request.messages,
        ...(request.tools.length > 0 ? { tools: request.tools, tool_choice: 'auto' } : {}),
      }),
    });

    if (!response.ok) throw new Error(await describeFailure(response));

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error('The endpoint returned a response that is not JSON.');
    }
    return parseCompletion(payload);
  } catch (err) {
    // The user's stop and the timeout both surface as the same AbortError, so
    // the caller's signal decides which one it was.
    if (request.signal?.aborted) throw new CancelledError();
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(
        `The endpoint did not respond within ${Math.round((request.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)}s.`,
      );
    }
    // A DNS or TLS failure surfaces as an opaque TypeError from fetch; name the
    // host so the user can tell a typo from an outage. The key is never included.
    if (err instanceof TypeError) {
      let host = 'the endpoint';
      try {
        host = new URL(endpoint).host;
      } catch {
        // Endpoint was already validated; fall back to the generic wording.
      }
      throw new Error(`Could not reach ${host}. Check the base URL and that the server is running.`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
    request.signal?.removeEventListener('abort', forwardAbort);
  }
}
