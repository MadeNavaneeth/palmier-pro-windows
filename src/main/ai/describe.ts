/**
 * Vision description over BYOK providers (#118 AI half).
 *
 * On-demand only: the caller (media:describe IPC or the `describe_media`
 * agent tool) supplies an explicit asset and a lightweight frame image —
 * the tile thumbnail when present, otherwise a single capped decode — and
 * this pure transport sends that ONE image to the user's own configured
 * provider. Nothing is cached outside the project; the returned sentence is
 * stored on the asset by the caller. Electron-free and unit-testable like
 * transcribe.ts: endpoint + key are injected, fetch is the only I/O besides
 * the image read.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { sanitizeAiDescription } from '../../shared/media/ai-description';

export interface VisionRuntime {
  kind: 'anthropic' | 'openai-compatible';
  /** API root. Defaults to the Anthropic API for kind 'anthropic'. */
  baseUrl?: string;
  apiKey: string;
  model: string;
  /** Preset id for error messages (e.g. "groq"). */
  providerId?: string;
}

export interface DescribeResult {
  description: string;
  model: string;
  provider: string;
}

/** Refuse images larger than this — tile thumbnails and 640px frames are KBs. */
export const DESCRIBE_IMAGE_MAX_BYTES = 3_000_000;

const PROMPT =
  'Describe this video frame in one concise sentence for media library search (max 80 words, plain text, no quotes).';

/**
 * True when the model is known to accept vision input.
 *
 * Denylist, not allowlist: unknown/custom models are attempted so a local
 * vision runtime with an opaque name still works; only models known to be
 * text/audio-only are refused at the boundary instead of sending a doomed
 * request. Anthropic Claude models all accept images.
 */
export function isVisionCapableModel(kind: VisionRuntime['kind'], model: string): boolean {
  const name = (model ?? '').trim();
  if (name.length === 0) return false;
  const lower = name.toLowerCase();
  if (lower.includes('whisper')) return false;
  if (lower.includes('musicgen')) return false;
  if (lower.includes('embedding')) return false;
  if (lower.includes('tts') || lower.includes('stt')) return false;
  if (lower.includes('flux') || lower.includes('diffusion')) return false;
  // Llama text models (Groq/Together/Cerebras/Ollama defaults) have no vision
  // unless the id says so (e.g. llama-3.2-vision).
  if (lower.includes('llama') && !lower.includes('vision')) return false;
  if (lower.includes('mixtral') && !lower.includes('vision')) return false;
  void kind;
  return true;
}

/** Throw a precise refusal naming provider + model when vision is unavailable. */
export function assertVisionCapable(runtime: VisionRuntime): void {
  if (isVisionCapableModel(runtime.kind, runtime.model)) return;
  const who = runtime.providerId ?? runtime.kind;
  throw new Error(
    `Model "${runtime.model}" (provider "${who}") is not vision-capable. ` +
      'Choose a vision model in AI settings (e.g. gpt-4o, claude-sonnet-4, gemini-2.5-flash).',
  );
}

function mimeForImagePath(imagePath: string): string {
  const ext = path.extname(imagePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/png';
}

/** Receipt-sized preview so the agent context does not carry 500 chars per asset. */
export function truncateForReceipt(description: string, max = 200): string {
  if (description.length <= max) return description;
  return `${description.slice(0, max).trimEnd()}…`;
}

async function readCappedImage(imagePath: string): Promise<{ base64: string; mime: string }> {
  let stat: { size: number };
  try {
    stat = await fs.stat(imagePath);
  } catch {
    throw new Error(`Frame image not found: ${imagePath}`);
  }
  if (stat.size > DESCRIBE_IMAGE_MAX_BYTES) {
    throw new Error(
      `Frame image is too large (${Math.round(stat.size / 1024)} KB). ` +
        'Describe uses the tile thumbnail or a 640px frame; use one of those.',
    );
  }
  const bytes = await fs.readFile(imagePath);
  return { base64: bytes.toString('base64'), mime: mimeForImagePath(imagePath) };
}

async function throwForStatus(response: Response, route: string): Promise<never> {
  const body = await response.text().catch(() => '');
  if (response.status === 401 || response.status === 403) {
    throw new Error('The endpoint rejected the API key (401/403). Check the key and the provider.');
  }
  if (response.status === 404) {
    throw new Error(`The endpoint has no ${route} route (404). Check the base URL.`);
  }
  if (response.status === 429) {
    throw new Error('The provider is rate limiting this key (429). Try again shortly.');
  }
  throw new Error(
    `Description failed (${response.status}): ${body.slice(0, 300) || response.statusText}`,
  );
}

async function describeViaAnthropic(
  runtime: VisionRuntime,
  base64: string,
  mime: string,
): Promise<string> {
  const base = (runtime.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '');
  const response = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': runtime.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: runtime.model,
      max_tokens: 300,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mime, data: base64 } },
            { type: 'text', text: PROMPT },
          ],
        },
      ],
    }),
  });
  if (!response.ok) await throwForStatus(response, '/v1/messages');
  const payload = (await response.json()) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  const text = (payload.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
    .trim();
  if (!text) throw new Error('The vision endpoint returned no description text.');
  return text;
}

async function describeViaOpenAiCompatible(
  runtime: VisionRuntime,
  base64: string,
  mime: string,
): Promise<string> {
  if (!runtime.baseUrl) throw new Error('This provider needs an API base URL. Set one in AI settings.');
  const base = runtime.baseUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (runtime.apiKey.length > 0) headers.Authorization = `Bearer ${runtime.apiKey}`;
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: runtime.model,
      max_tokens: 300,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: PROMPT },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
          ],
        },
      ],
    }),
  });
  if (!response.ok) await throwForStatus(response, '/chat/completions');
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  const text = typeof content === 'string' ? content.trim() : '';
  if (!text) throw new Error('The vision endpoint returned no description text.');
  return text;
}

export async function describeImage(
  runtime: VisionRuntime,
  imagePath: string,
): Promise<DescribeResult> {
  assertVisionCapable(runtime);
  // Local runtimes accept unauthenticated requests, so a missing key is only
  // fatal for providers that need one (same rule as the chat transport).
  if (!runtime.apiKey && runtime.kind === 'anthropic') {
    throw new Error('No API key configured for this provider.');
  }
  const { base64, mime } = await readCappedImage(imagePath);
  const raw =
    runtime.kind === 'anthropic'
      ? await describeViaAnthropic(runtime, base64, mime)
      : await describeViaOpenAiCompatible(runtime, base64, mime);
  const description = sanitizeAiDescription(raw);
  if (!description) throw new Error('The vision endpoint returned an empty description.');
  return {
    description,
    model: runtime.model,
    provider: runtime.providerId ?? runtime.kind,
  };
}
