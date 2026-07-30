/**
 * LLM provider configuration (upstream issues #17 and #140).
 *
 * Two requests, one shape: #17 asked for a configurable API base URL, #140 for
 * OpenAI-compatible providers. Both are satisfied by an `openai-compatible`
 * provider kind whose base URL the user supplies, which also covers local
 * runtimes such as Ollama and LM Studio without a per-vendor code path.
 *
 * Validation lives here rather than in the settings form because the base URL
 * arrives from three directions — the form, the persisted config store, and the
 * IPC handler — and a URL that reaches the request layer unchecked is the one
 * that quietly sends timeline content somewhere unintended.
 */

export type ProviderKind = 'anthropic' | 'openai-compatible';

export interface ProviderConfig {
  kind: ProviderKind;
  /**
   * API root, e.g. `https://api.openai.com/v1`.
   *
   * Optional for Anthropic, where the SDK's default is used unless the user
   * points at a gateway. Required for `openai-compatible`, which has no
   * meaningful default.
   */
  baseUrl?: string;
  model: string;
}

/** A ready-made endpoint, so the common cases need no URL typing. */
export interface ProviderPreset {
  id: string;
  label: string;
  kind: ProviderKind;
  /** Undefined means "use the SDK default". */
  baseUrl?: string;
  defaultModel: string;
  /** Local runtimes usually ignore the key, but the field must still exist. */
  requiresApiKey: boolean;
  hint?: string;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    kind: 'anthropic',
    defaultModel: 'claude-sonnet-4-20250514',
    requiresApiKey: true,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    kind: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
    requiresApiKey: true,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'anthropic/claude-sonnet-4',
    requiresApiKey: true,
  },
  {
    id: 'groq',
    label: 'Groq',
    kind: 'openai-compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    requiresApiKey: true,
  },
  {
    id: 'together',
    label: 'Together AI',
    kind: 'openai-compatible',
    baseUrl: 'https://api.together.xyz/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    requiresApiKey: true,
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    kind: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:11434/v1',
    defaultModel: 'llama3.1',
    requiresApiKey: false,
    hint: 'Requires a running local Ollama server.',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    kind: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:1234/v1',
    defaultModel: 'local-model',
    requiresApiKey: false,
    hint: 'Start the LM Studio local server first.',
  },
  {
    id: 'custom',
    label: 'Custom endpoint',
    kind: 'openai-compatible',
    defaultModel: '',
    requiresApiKey: true,
    hint: 'Any OpenAI-compatible /chat/completions endpoint.',
  },
] as const;

export function presetById(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === id);
}

export type UrlValidation =
  | { ok: true; url: string; isLoopback: boolean }
  | { ok: false; reason: string };

/**
 * Hosts allowed to be reached over plain HTTP.
 *
 * Local model runtimes serve HTTP on the loopback interface and cannot present a
 * certificate, so refusing plaintext outright would rule out the main reason
 * people want a custom endpoint. Traffic to a loopback address does not leave
 * the machine, so there is nothing on the wire to intercept. Every other host
 * must use TLS: the request carries an API key and project content.
 */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true;
  // The whole 127.0.0.0/8 block, not just 127.0.0.1.
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map(Number);
  return octets.every((value) => value >= 0 && value <= 255) && octets[0] === 127;
}

/**
 * Validate and normalize an API base URL.
 *
 * Rejections, and why each one matters:
 * - non-http(s) scheme: `file:` or `data:` are not endpoints, and letting them
 *   through turns a settings field into a local-file read.
 * - plaintext HTTP to a non-loopback host: the API key and the project payload
 *   would travel in clear text.
 * - credentials in the URL: they would end up in the config store and in any
 *   error message that echoes the endpoint.
 * - query or fragment: a base URL is a prefix; a query string on it silently
 *   breaks once a path is appended.
 */
export function validateBaseUrl(raw: unknown): UrlValidation {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { ok: false, reason: 'Enter an API base URL.' };
  }

  const trimmed = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'That is not a valid URL. Include the scheme, e.g. https://host/v1' };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, reason: 'Only http and https URLs are supported.' };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'Remove the username and password from the URL. Use the API key field.' };
  }

  if (parsed.search || parsed.hash) {
    return { ok: false, reason: 'The base URL cannot contain a query string or fragment.' };
  }

  if (!parsed.hostname) {
    return { ok: false, reason: 'The URL is missing a host.' };
  }

  const isLoopback = isLoopbackHost(parsed.hostname);
  if (parsed.protocol === 'http:' && !isLoopback) {
    return {
      ok: false,
      reason: 'Plain http is only allowed for localhost. Use https for remote endpoints.',
    };
  }

  // Normalize: keep the path (providers differ on /v1), drop trailing slashes so
  // joining a path cannot produce a double slash.
  const path = parsed.pathname.replace(/\/+$/, '');
  return { ok: true, url: `${parsed.protocol}//${parsed.host}${path}`, isLoopback };
}

/** Join a validated base URL with an API path. */
export function resolveEndpoint(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}

export type ConfigValidation =
  | { ok: true; config: ProviderConfig }
  | { ok: false; reason: string };

/**
 * Validate a whole provider configuration.
 *
 * `openai-compatible` requires a base URL because there is no sensible default;
 * Anthropic treats it as an optional override for a gateway.
 */
export function validateProviderConfig(input: {
  kind?: unknown;
  baseUrl?: unknown;
  model?: unknown;
}): ConfigValidation {
  const kind = input.kind;
  if (kind !== 'anthropic' && kind !== 'openai-compatible') {
    return { ok: false, reason: 'Unknown provider type.' };
  }

  const model = typeof input.model === 'string' ? input.model.trim() : '';
  if (model.length === 0) {
    return { ok: false, reason: 'Enter a model name.' };
  }
  if (model.length > 200) {
    return { ok: false, reason: 'Model name is too long.' };
  }

  const hasBaseUrl = typeof input.baseUrl === 'string' && input.baseUrl.trim().length > 0;

  if (kind === 'openai-compatible' && !hasBaseUrl) {
    return { ok: false, reason: 'An OpenAI-compatible provider needs an API base URL.' };
  }

  if (!hasBaseUrl) return { ok: true, config: { kind, model } };

  const url = validateBaseUrl(input.baseUrl);
  if (!url.ok) return { ok: false, reason: url.reason };

  return { ok: true, config: { kind, baseUrl: url.url, model } };
}

/**
 * True when a configured endpoint sends data off this machine.
 *
 * Drives the settings warning: a custom endpoint receives the project's timeline
 * structure along with the prompt, and the user should be told which category
 * their endpoint falls into before they use it.
 */
export function endpointLeavesMachine(config: ProviderConfig): boolean {
  if (!config.baseUrl) return true; // SDK default is a hosted API.
  const url = validateBaseUrl(config.baseUrl);
  return url.ok ? !url.isLoopback : true;
}
