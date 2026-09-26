import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import {
  assertVisionCapable,
  describeImage,
  isVisionCapableModel,
} from './describe';

let tmpDir = '';
let pngPath = '';
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'palmier-describe-'));
  pngPath = path.join(tmpDir, 'frame.png');
  await fs.writeFile(pngPath, Buffer.from(PNG_BASE64, 'base64'));
  vi.unstubAllGlobals();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('isVisionCapableModel (#118 AI half)', () => {
  it('allows Claude, gpt-4o, gemini and unknown custom models', () => {
    expect(isVisionCapableModel('anthropic', 'claude-sonnet-4-20250514')).toBe(true);
    expect(isVisionCapableModel('openai-compatible', 'gpt-4o')).toBe(true);
    expect(isVisionCapableModel('openai-compatible', 'gemini-2.5-flash')).toBe(true);
    expect(isVisionCapableModel('openai-compatible', 'local-model')).toBe(true);
  });

  it('refuses known text/audio-only models at the boundary', () => {
    expect(isVisionCapableModel('openai-compatible', 'llama-3.3-70b-versatile')).toBe(false);
    expect(isVisionCapableModel('openai-compatible', 'meta-llama/Llama-3.3-70B-Instruct-Turbo')).toBe(false);
    expect(isVisionCapableModel('openai-compatible', 'llama3.1')).toBe(false);
    expect(isVisionCapableModel('openai-compatible', 'whisper-1')).toBe(false);
    expect(isVisionCapableModel('openai-compatible', '')).toBe(false);
  });

  it('assertVisionCapable names provider and model', () => {
    expect(() =>
      assertVisionCapable({
        kind: 'openai-compatible',
        baseUrl: 'https://x/v1',
        apiKey: 'k',
        model: 'llama-3.3-70b-versatile',
        providerId: 'groq',
      }),
    ).toThrow(/groq.*llama|llama.*groq/i);
  });
});

describe('describeImage (#118 AI half)', () => {
  it('sends image_url for openai-compatible and sanitizes the reply', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ choices: [{ message: { content: '  A red\ncar.  ' } }] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const out = await describeImage(
      { kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-4o' },
      pngPath,
    );
    expect(out.description).toBe('A red car.');
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: Array<{ type: string }> }>;
    };
    expect(body.messages[0].content.some((b) => b.type === 'image_url')).toBe(true);
  });

  it('sends Anthropic image blocks', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ content: [{ type: 'text', text: 'Harbour at dusk.' }] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const out = await describeImage(
      { kind: 'anthropic', apiKey: 'k', model: 'claude-sonnet-4-20250514', providerId: 'anthropic' },
      pngPath,
    );
    expect(out.description).toBe('Harbour at dusk.');
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toContain('/v1/messages');
  });

  it('refuses a non-vision model without sending', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      describeImage(
        {
          kind: 'openai-compatible',
          baseUrl: 'https://x/v1',
          apiKey: 'k',
          model: 'llama-3.3-70b-versatile',
          providerId: 'groq',
        },
        pngPath,
      ),
    ).rejects.toThrow(/not vision-capable/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a missing image without sending', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      describeImage(
        { kind: 'openai-compatible', baseUrl: 'https://x/v1', apiKey: 'k', model: 'gpt-4o' },
        path.join(tmpDir, 'missing.png'),
      ),
    ).rejects.toThrow(/not found/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
