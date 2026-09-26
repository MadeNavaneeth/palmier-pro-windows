/**
 * Reference images, last hop: a local path must become something the provider
 * API accepts (a data URI) before it is submitted, on both entry points.
 *
 * `generate_media` (Agent) and the `generation:start` IPC shell both hand a
 * validated local path to the same adapters, so these tests drive both against
 * the real fal.ai adapter with a stubbed transport: the encoding contract, the
 * refusals that must cost no provider call, and the guarantee that a run
 * without a reference is unchanged on the wire.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { EditorController } from '../../shared/editor/controller';
import { MAX_REFERENCE_IMAGE_BYTES, REFERENCE_IMAGE_EXTENSIONS } from '../ai/tools';
import { setGenerationProviders } from './manager';
import { FalProvider } from './provider-fal';
import { encodeReferenceImage } from './reference-image';
import { ToolExecutor } from '../ai/executor';

vi.mock('electron', () => ({ app: undefined }));

/** A 1x1 PNG: real bytes, so it is a real image and a small one. */
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const ONE_PIXEL_PNG_DATA_URI = `data:image/png;base64,${ONE_PIXEL_PNG.toString('base64')}`;

const IMAGE_TARGET = {
  provider: 'fal.ai',
  model: 'fal-ai/flux/dev',
  type: 'image' as const,
  field: 'image_url',
};

/** Minimal but real leading bytes for each accepted type. */
const SIGNATURE_SAMPLES: Readonly<Record<string, Buffer>> = {
  '.png': ONE_PIXEL_PNG,
  '.jpg': Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]),
  '.jpeg': Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]),
  '.webp': Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]),
  '.gif': Buffer.from('GIF89a', 'latin1'),
  '.bmp': Buffer.concat([Buffer.from('BM'), Buffer.alloc(12)]),
};

describe('encodeReferenceImage', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'palmier-refimg-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('encodes a supported image as a data URI carrying the exact bytes', async () => {
    const file = path.join(tmpDir, 'ref.png');
    await fs.writeFile(file, ONE_PIXEL_PNG);

    const uri = await encodeReferenceImage(file, IMAGE_TARGET);

    expect(uri).toBe(ONE_PIXEL_PNG_DATA_URI);
    expect(Buffer.from(uri.slice('data:image/png;base64,'.length), 'base64').equals(ONE_PIXEL_PNG))
      .toBe(true);
  });

  it('encodes every published reference type as image data', async () => {
    // A type added to the allowlist without a media type would be refused here
    // even though the boundary accepted it.
    expect([...REFERENCE_IMAGE_EXTENSIONS].sort()).toEqual([...Object.keys(SIGNATURE_SAMPLES)].sort());

    for (const extension of REFERENCE_IMAGE_EXTENSIONS) {
      const file = path.join(tmpDir, `ref${extension}`);
      await fs.writeFile(file, SIGNATURE_SAMPLES[extension]!);
      const uri = await encodeReferenceImage(file, IMAGE_TARGET);
      expect(uri.startsWith('data:image/'), `${extension} must encode as image data`).toBe(true);
      expect(uri).toContain(';base64,');
    }
  });

  describe('refusals', () => {
    const CASES: Array<{
      label: string;
      resolve(dir: string): string;
      prepare(dir: string, target: string): Promise<void>;
      reason: RegExp;
    }> = [
      {
        label: 'a missing file',
        resolve: (dir) => path.join(dir, 'absent.png'),
        prepare: async () => {},
        reason: /Reference image not found/,
      },
      {
        label: 'a file that is not an image',
        resolve: (dir) => path.join(dir, 'notes.txt'),
        prepare: async (_dir, target) => { await fs.writeFile(target, 'not an image'); },
        reason: /is not one of \.png, \.jpg, \.jpeg, \.webp, \.gif, \.bmp/,
      },
      {
        label: 'a mislabelled non-image',
        resolve: (dir) => path.join(dir, 'fake.png'),
        prepare: async (_dir, target) => { await fs.writeFile(target, 'still not an image'); },
        reason: /not a readable \.png file/,
      },
      {
        label: 'an empty image file',
        resolve: (dir) => path.join(dir, 'empty.png'),
        prepare: async (_dir, target) => { await fs.writeFile(target, ''); },
        reason: /Reference image is empty/,
      },
      {
        label: 'an image over the size cap',
        resolve: (dir) => path.join(dir, 'huge.png'),
        prepare: async (_dir, target) => {
          await fs.writeFile(target, Buffer.alloc(MAX_REFERENCE_IMAGE_BYTES + 1));
        },
        reason: /the cap is 8 MB/,
      },
    ];

    it.each(CASES)('refuses $label', async ({ resolve: resolveCase, prepare, reason }) => {
      const target = resolveCase(tmpDir);
      await prepare(tmpDir, target);

      await expect(encodeReferenceImage(target, IMAGE_TARGET)).rejects.toThrow(reason);
    });

    it('refuses a video target rather than sending a picture to a text-to-video model', async () => {
      const file = path.join(tmpDir, 'ref.png');
      await fs.writeFile(file, ONE_PIXEL_PNG);

      await expect(encodeReferenceImage(file, {
        ...IMAGE_TARGET,
        model: 'fal-ai/kling-video/v1/standard/text-to-video',
        type: 'video',
      })).rejects.toThrow(/generates video from text only.*would be ignored/s);
    });

    it('refuses a provider that cannot carry an inline reference at all', async () => {
      const file = path.join(tmpDir, 'ref.png');
      await fs.writeFile(file, ONE_PIXEL_PNG);

      await expect(encodeReferenceImage(file, {
        ...IMAGE_TARGET,
        unsupported: 'this provider needs a hosted URL and this adapter uploads nothing.',
      })).rejects.toThrow('this provider needs a hosted URL and this adapter uploads nothing.');
    });
  });
});

/**
 * A transport that records the request and refuses it, so no run ever
 * completes: the point of these tests is the outbound body, and a loud
 * provider rejection keeps real media work (download, ffprobe) out of the suite.
 */
function stubbedTransport(): { calls: Array<{ url: string; body: unknown }> } {
  const calls: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return {
      ok: false,
      status: 422,
      json: async () => ({}),
      text: async () => 'provider rejected the request',
    } as Response;
  }));
  return { calls };
}

describe('reference image reaches the provider as a data URI', () => {
  let tmpDir: string;
  let referencePath: string;

  beforeEach(async () => {
    setGenerationProviders([]);
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'palmier-refwire-'));
    referencePath = path.join(tmpDir, 'reference.png');
    await fs.writeFile(referencePath, ONE_PIXEL_PNG);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.rm(tmpDir, { recursive: true, force: true });
    setGenerationProviders([]);
  });

  function configuredFal(): FalProvider {
    const provider = new FalProvider();
    provider.configure('fal-test-key');
    setGenerationProviders([provider]);
    return provider;
  }

  function agent(): ToolExecutor {
    return new ToolExecutor(new EditorController());
  }

  it('through the Agent tool, the outbound request carries the data URI, not the path', async () => {
    const { calls } = stubbedTransport();
    configuredFal();

    const result = await agent().execute('generate_media', {
      type: 'image',
      prompt: 'the same harbour at night',
      providerId: 'fal',
      referenceImagePath: referencePath,
    });

    // The transport refused, which is what proves the reference itself was not
    // the reason the call was refused.
    expect(result.success).toBe(false);
    expect(result.error).toContain('fal.ai submit failed (422)');
    expect(calls).toHaveLength(1);
    const body = calls[0]!.body as { image_url?: string };
    expect(body.image_url).toBe(ONE_PIXEL_PNG_DATA_URI);
    expect(JSON.stringify(body)).not.toContain(referencePath);
  });

  it('through the Agent tool, an unreadable reference is refused before the provider is called', async () => {
    const { calls } = stubbedTransport();
    configuredFal();

    const result = await agent().execute('generate_media', {
      type: 'image',
      prompt: 'a quiet harbour at dusk',
      providerId: 'fal',
      referenceImagePath: path.join(tmpDir, 'gone.png'),
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Reference image not found/);
    expect(calls).toHaveLength(0);
  });

  it('through the Agent tool, an oversized reference is refused before the provider is called', async () => {
    const { calls } = stubbedTransport();
    configuredFal();
    const huge = path.join(tmpDir, 'huge.png');
    await fs.writeFile(huge, Buffer.alloc(MAX_REFERENCE_IMAGE_BYTES + 1));

    const result = await agent().execute('generate_media', {
      type: 'image',
      prompt: 'a quiet harbour at dusk',
      providerId: 'fal',
      referenceImagePath: huge,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/the cap is 8 MB/);
    expect(calls).toHaveLength(0);
  });

  it('through the Agent tool, a non-image is refused before the provider is called', async () => {
    const { calls } = stubbedTransport();
    configuredFal();
    const notes = path.join(tmpDir, 'notes.txt');
    await fs.writeFile(notes, 'not an image');

    const result = await agent().execute('generate_media', {
      type: 'image',
      prompt: 'a quiet harbour at dusk',
      providerId: 'fal',
      referenceImagePath: notes,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/must be one of \.png, \.jpg, \.jpeg, \.webp, \.gif, \.bmp/);
    expect(calls).toHaveLength(0);
  });

  it('through the Agent tool, a reference on a video model is still refused', async () => {
    const { calls } = stubbedTransport();
    configuredFal();

    const result = await agent().execute('generate_media', {
      type: 'video',
      prompt: 'slow push in on the harbour',
      providerId: 'fal',
      referenceImagePath: referencePath,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('is a video model and reads no reference image');
    expect(calls).toHaveLength(0);
  });

  it('through the Agent tool, no reference leaves the outbound request without an image field', async () => {
    const { calls } = stubbedTransport();
    configuredFal();

    const result = await agent().execute('generate_media', {
      type: 'image',
      prompt: 'a quiet harbour at dusk',
      providerId: 'fal',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('fal.ai submit failed (422)');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ prompt: 'a quiet harbour at dusk' });
  });
});
