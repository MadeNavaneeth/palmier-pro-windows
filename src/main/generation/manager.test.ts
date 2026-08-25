/**
 * Coverage for the generation manager (PR #406 registry family): provider
 * resolution, the configured-key gate, failure-as-result semantics, and the
 * timeout that cancels the underlying request. Providers here are fakes —
 * the real ones hit network APIs.
 */
import { describe, it, expect, vi } from 'vitest';
import type { GenerationProvider, GenerationRequest, GenerationResult } from './types';
import {
  setGenerationProviders,
  configuredProvidersFor,
  listGenerationProviders,
  runGeneration,
  GenerationTimeoutError,
} from './manager';

function fakeProvider(overrides: Partial<GenerationProvider> = {}): GenerationProvider {
  return {
    id: 'fake',
    name: 'Fake',
    supportedTypes: ['image', 'video', 'audio'],
    isConfigured: () => true,
    configure: () => {},
    getModels: () => ['fake-model-1'],
    generate: async (request: GenerationRequest): Promise<GenerationResult> => ({
      id: request.id,
      status: 'completed',
      outputPath: `C:/cache/${request.id}.mp4`,
    }),
    cancel: async () => {},
    ...overrides,
  };
}

/** Restore an empty registry after each test (manager keeps module state). */
afterEach(() => setGenerationProviders([]));

describe('generation manager (#406 registry)', () => {
  it('resolves only configured providers supporting the requested type', () => {
    const keyedVideo = fakeProvider({ id: 'keyed-video', supportedTypes: ['video'] });
    const unconfigured = fakeProvider({
      id: 'unconfigured',
      supportedTypes: ['video'],
      isConfigured: () => false,
    });
    const audioOnly = fakeProvider({ id: 'audio-only', supportedTypes: ['audio'] });
    setGenerationProviders([keyedVideo, unconfigured, audioOnly]);

    const resolved = configuredProvidersFor('video');
    expect(resolved).toEqual([keyedVideo]);
    expect(configuredProvidersFor('audio')).toEqual([audioOnly]);
  });

  it('rejects before submitting when the provider has no key', async () => {
    const generate = vi.fn();
    setGenerationProviders([fakeProvider({ id: 'locked', isConfigured: () => false, generate })]);

    await expect(runGeneration({ type: 'image', prompt: 'x', provider: 'locked' }))
      .rejects.toThrow(/no API key/);
    expect(generate).not.toHaveBeenCalled();
  });

  it('converts a provider throw into a failed result instead of rejecting', async () => {
    setGenerationProviders([
      fakeProvider({
        id: 'boom',
        generate: async () => { throw new Error('provider exploded'); },
      }),
    ]);

    const result = await runGeneration({ type: 'image', prompt: 'x', provider: 'boom' });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('provider exploded');
  });

  it('times out and cancels the provider request', async () => {
    const cancel = vi.fn(async () => {});
    let release!: (r: GenerationResult) => void;
    setGenerationProviders([
      fakeProvider({
        id: 'slow',
        generate: () => new Promise<GenerationResult>((resolve) => { release = resolve; }),
        cancel,
      }),
    ]);

    const pending = runGeneration(
      { type: 'video', prompt: 'x', provider: 'slow' },
      { timeoutMs: 25 },
    );
    await expect(pending).rejects.toBeInstanceOf(GenerationTimeoutError);
    // Give the cancel call a microtask to land.
    await Promise.resolve();
    expect(cancel).toHaveBeenCalled();
    // The late completion must not reject anything unhandled.
    release({ id: 'late', status: 'completed' });
  });

  it('lists providers with their per-type model catalogs', () => {
    setGenerationProviders([fakeProvider({ id: 'cat', name: 'Catalog' })]);
    const listed = listGenerationProviders();

    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: 'cat',
      name: 'Catalog',
      configured: true,
      models: { image: ['fake-model-1'], video: ['fake-model-1'], audio: ['fake-model-1'] },
    });
  });
});
