import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { GenerationRequest } from './types';
import { FalProvider } from './provider-fal';
import { HiggsFieldProvider } from './provider-higgsfield';
import { ReplicateProvider } from './provider-replicate';

vi.mock('electron', () => ({ app: undefined }));

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  const text = JSON.stringify(body);
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
    text: async () => text,
  } as Response;
}

function request(provider: string, type: 'image' | 'video' = 'image'): GenerationRequest {
  return { id: `palmier-${provider}`, provider, type, prompt: 'test' };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('generation provider cancellation contracts', () => {
  it('sends Replicate cancellation to the provider prediction id', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new ReplicateProvider();
    provider.configure('replicate-key');

    await provider.cancel('prediction-from-provider');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.replicate.com/v1/predictions/prediction-from-provider/cancel',
      {
        method: 'POST',
        headers: { 'Authorization': 'Bearer replicate-key' },
      },
    );
  });

  it('surfaces a rejected Replicate cancel instead of claiming it succeeded', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(
      { error: 'cannot cancel' },
      { ok: false, status: 409 },
    )));
    const provider = new ReplicateProvider();
    provider.configure('replicate-key');

    await expect(provider.cancel('prediction-1')).rejects.toThrow(
      'Replicate cancel failed (409)',
    );
  });

  it('captures each provider job id as soon as submission returns', async () => {
    const cases = [
      {
        provider: new ReplicateProvider(),
        request: request('replicate'),
        response: { id: 'replicate-provider-id' },
        expected: 'replicate-provider-id',
      },
      {
        provider: new FalProvider(),
        request: request('fal'),
        response: { request_id: 'fal-provider-id' },
        expected: 'fal-provider-id',
      },
      {
        provider: new HiggsFieldProvider(),
        request: request('higgsfield', 'video'),
        response: { id: 'higgsfield-provider-id' },
        expected: 'higgsfield-provider-id',
      },
    ];

    for (const testCase of cases) {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(testCase.response)));
      testCase.provider.configure('key');
      const controller = new AbortController();
      let captured!: (id: string) => void;
      const capturedPromise = new Promise<string>((resolve) => { captured = resolve; });
      const generation = testCase.provider.generate(
        testCase.request,
        undefined,
        {
          signal: controller.signal,
          onProviderRequest: (id) => captured(id),
        },
      );

      await expect(capturedPromise).resolves.toBe(testCase.expected);
      controller.abort();
      await expect(generation).resolves.toMatchObject({ status: 'failed' });
    }
  });

  it('declares fal and Higgs Field local-only instead of faking remote cancellation', () => {
    expect(new ReplicateProvider().cancellationSupport).toBe('remote');
    expect(new FalProvider().cancellationSupport).toBe('local-only');
    expect(new HiggsFieldProvider().cancellationSupport).toBe('local-only');
  });
});

/**
 * What each provider actually receives. A reference arrives as a local path and
 * must leave as a data URI in the field that provider documents as an image
 * input; a model that reads none is refused before the submission rather than
 * sent a request that would come back with an unrelated image.
 */
describe('reference images on the wire', () => {
  const ONE_PIXEL_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
  const DATA_URI = `data:image/png;base64,${ONE_PIXEL_PNG.toString('base64')}`;

  let tmpDir: string;
  let referencePath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'palmier-provider-ref-'));
    referencePath = path.join(tmpDir, 'reference.png');
    await fs.writeFile(referencePath, ONE_PIXEL_PNG);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** Records the submitted body, then refuses so the adapter stops there. */
  function stubbedSubmit(): { bodies: string[] } {
    const bodies: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return {
        ok: false,
        status: 422,
        json: async () => ({}),
        text: async () => 'provider rejected the request',
      } as Response;
    }));
    return { bodies };
  }

  function fal(): FalProvider {
    const provider = new FalProvider();
    provider.configure('fal-key');
    return provider;
  }

  function replicate(): ReplicateProvider {
    const provider = new ReplicateProvider();
    provider.configure('replicate-key');
    return provider;
  }

  function higgsfield(): HiggsFieldProvider {
    const provider = new HiggsFieldProvider();
    provider.configure('higgsfield-key');
    return provider;
  }

  it('sends fal a data URI in image_url, never the local path', async () => {
    const { bodies } = stubbedSubmit();

    await fal().generate({
      id: 'ref-fal',
      provider: 'fal',
      type: 'image',
      prompt: 'the same harbour at night',
      referenceImagePath: referencePath,
    });

    expect(bodies).toHaveLength(1);
    const payload = JSON.parse(bodies[0]!) as { prompt: string; image_url: string };
    expect(payload.prompt).toBe('the same harbour at night');
    expect(payload.image_url).toBe(DATA_URI);
    expect(bodies[0]).not.toContain(referencePath);
  });

  it('sends Replicate a data URI in input.image, never the local path', async () => {
    const { bodies } = stubbedSubmit();

    await replicate().generate({
      id: 'ref-replicate',
      provider: 'replicate',
      type: 'image',
      prompt: 'the same harbour at night',
      referenceImagePath: referencePath,
    });

    expect(bodies).toHaveLength(1);
    const payload = JSON.parse(bodies[0]!) as { model: string; input: { image: string } };
    expect(payload.model).toBe('stability-ai/sdxl:latest');
    expect(payload.input.image).toBe(DATA_URI);
    expect(bodies[0]).not.toContain(referencePath);
  });

  it('refuses a Higgs Field reference, whose first frame is a URL it must fetch', async () => {
    const { bodies } = stubbedSubmit();

    const result = await higgsfield().generate({
      id: 'ref-higgsfield',
      provider: 'higgsfield',
      type: 'video',
      prompt: 'slow push in on the harbour',
      referenceImagePath: referencePath,
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('Higgs Field diffuse-v1 conditions on a first frame the service fetches from a public URL');
    expect(result.error).toContain('uploads nothing');
    expect(bodies).toHaveLength(0);
  });

  it.each([
    {
      label: 'fal',
      generate: (reference: string) => fal().generate({
        id: 'ref-fal-video',
        provider: 'fal',
        type: 'video',
        prompt: 'slow push in',
        referenceImagePath: reference,
      }),
      reason: /fal\.ai fal-ai\/kling-video\/v1\/standard\/text-to-video generates video from text only/,
    },
    {
      label: 'Replicate',
      generate: (reference: string) => replicate().generate({
        id: 'ref-replicate-video',
        provider: 'replicate',
        type: 'video',
        prompt: 'slow push in',
        referenceImagePath: reference,
      }),
      reason: /Replicate stability-ai\/stable-video-diffusion:latest generates video from text only/,
    },
  ])('refuses a reference on a $label video model before submitting', async ({ generate, reason }) => {
    const { bodies } = stubbedSubmit();

    const result = await generate(referencePath);

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(reason);
    expect(result.error).toContain('would be ignored');
    expect(bodies).toHaveLength(0);
  });

  it('sends byte-identical requests when no reference is supplied', async () => {
    const cases: Array<{ expected: string; run: () => Promise<unknown> }> = [
      {
        expected: '{"prompt":"test"}',
        run: () => fal().generate({ id: 'plain-fal', provider: 'fal', type: 'image', prompt: 'test' }),
      },
      {
        expected: '{"model":"stability-ai/sdxl:latest","input":{"prompt":"test"}}',
        run: () => replicate().generate({ id: 'plain-replicate', provider: 'replicate', type: 'image', prompt: 'test' }),
      },
      {
        expected: '{"model":"diffuse-v1","prompt":"test","duration":5,"width":1280,"height":720}',
        run: () => higgsfield().generate({ id: 'plain-higgsfield', provider: 'higgsfield', type: 'video', prompt: 'test' }),
      },
    ];

    for (const testCase of cases) {
      const { bodies } = stubbedSubmit();
      await testCase.run();
      expect(bodies).toEqual([testCase.expected]);
    }
  });
});
