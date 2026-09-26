/**
 * Coverage for the generation manager (PR #406 registry family): provider
 * resolution, the configured-key gate, failure-as-result semantics, and the
 * timeout that cancels the underlying request. Providers here are fakes —
 * the real ones hit network APIs.
 */
import { describe, it, expect, vi } from 'vitest';
import type {
  GenerationExecutionContext,
  GenerationProvider,
  GenerationRequest,
  GenerationResult,
} from './types';
import {
  cancelGeneration,
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

  it('times out with the provider id and reports terminal progress', async () => {
    const cancel = vi.fn(async () => {});
    let release!: (r: GenerationResult) => void;
    let captured!: () => void;
    const providerRequestCaptured = new Promise<void>((resolve) => { captured = resolve; });
    const onProgress = vi.fn();
    setGenerationProviders([
      fakeProvider({
        id: 'slow',
        generate: (_request, _onProgress, execution) => {
          execution?.onProviderRequest('remote-timeout-id');
          captured();
          return new Promise<GenerationResult>((resolve) => { release = resolve; });
        },
        cancel,
      }),
    ]);

    const pending = runGeneration(
      { type: 'video', prompt: 'x', provider: 'slow' },
      { timeoutMs: 25, onProgress },
    );
    await providerRequestCaptured;
    await expect(pending).rejects.toBeInstanceOf(GenerationTimeoutError);
    expect(cancel).toHaveBeenCalledWith('remote-timeout-id');
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      percent: 100,
    }));
    release({ id: 'late', status: 'completed' });
    await Promise.resolve();
  });

  it('cancels with the provider request id and drops the late result', async () => {
    const cancel = vi.fn(async () => {});
    let release!: (result: GenerationResult) => void;
    let captured!: () => void;
    const providerRequestCaptured = new Promise<void>((resolve) => { captured = resolve; });
    let localRequestId = '';
    setGenerationProviders([
      fakeProvider({
        id: 'remote-cancel',
        generate: (_request, _onProgress, execution) => {
          execution?.onProviderRequest('prediction-from-provider');
          captured();
          return new Promise<GenerationResult>((resolve) => { release = resolve; });
        },
        cancel,
      }),
    ]);

    const pending = runGeneration(
      { type: 'image', prompt: 'x', provider: 'remote-cancel' },
      { onStart: (id) => { localRequestId = id; } },
    );
    await providerRequestCaptured;

    await expect(cancelGeneration(localRequestId)).resolves.toEqual({
      success: true,
      remoteCancellation: 'confirmed',
    });
    expect(cancel).toHaveBeenCalledWith('prediction-from-provider');
    expect(cancel).not.toHaveBeenCalledWith(localRequestId);
    await expect(pending).resolves.toMatchObject({ status: 'cancelled' });

    release({ id: localRequestId, status: 'completed', outputPath: 'late-output' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(cancelGeneration(localRequestId)).resolves.toMatchObject({
      success: true,
      remoteCancellation: 'not-found',
    });
  });

  it('keeps submission alive to capture an id when cancellation wins the race', async () => {
    const cancel = vi.fn(async () => {});
    let release!: (result: GenerationResult) => void;
    let started!: () => void;
    let execution!: GenerationExecutionContext;
    const providerStarted = new Promise<void>((resolve) => { started = resolve; });
    let localRequestId = '';
    setGenerationProviders([
      fakeProvider({
        id: 'submission-race',
        generate: (_request, _onProgress, currentExecution) => {
          execution = currentExecution!;
          started();
          return new Promise<GenerationResult>((resolve) => { release = resolve; });
        },
        cancel,
      }),
    ]);

    const pending = runGeneration(
      { type: 'image', prompt: 'x', provider: 'submission-race' },
      { onStart: (id) => { localRequestId = id; } },
    );
    await providerStarted;
    await expect(cancelGeneration(localRequestId)).resolves.toMatchObject({
      remoteCancellation: 'pending',
    });
    expect(execution.signal.aborted).toBe(false);

    execution.onProviderRequest('provider-id-after-cancel');
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledWith('provider-id-after-cancel');
    expect(execution.signal.aborted).toBe(true);
    await expect(pending).resolves.toMatchObject({ status: 'cancelled' });

    release({ id: localRequestId, status: 'completed' });
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it('treats cancellation of unknown and finished jobs as a safe no-op', async () => {
    await expect(cancelGeneration('unknown')).resolves.toEqual({
      success: true,
      remoteCancellation: 'not-found',
    });

    setGenerationProviders([fakeProvider({ id: 'finished' })]);
    const result = await runGeneration({ type: 'image', prompt: 'x', provider: 'finished' });
    expect(result.status).toBe('completed');
    await expect(cancelGeneration(result.id)).resolves.toEqual({
      success: true,
      remoteCancellation: 'not-found',
    });
  });

  it('reports local-only providers honestly and does not fake a remote cancel', async () => {
    const cancel = vi.fn(async () => {});
    let captured!: () => void;
    const providerRequestCaptured = new Promise<void>((resolve) => { captured = resolve; });
    let localRequestId = '';
    setGenerationProviders([
      fakeProvider({
        id: 'local-only',
        cancellationSupport: 'local-only',
        generate: (_request, _onProgress, execution) => {
          execution?.onProviderRequest('remote-job-continues');
          captured();
          return new Promise<GenerationResult>((resolve) => {
            execution?.signal.addEventListener('abort', () => {
              resolve({ id: 'local-only', status: 'failed' });
            }, { once: true });
          });
        },
        cancel,
      }),
    ]);

    const pending = runGeneration(
      { type: 'image', prompt: 'x', provider: 'local-only' },
      { onStart: (id) => { localRequestId = id; } },
    );
    await providerRequestCaptured;
    await expect(cancelGeneration(localRequestId)).resolves.toEqual({
      success: true,
      remoteCancellation: 'unsupported',
    });
    expect(cancel).not.toHaveBeenCalled();
    await expect(pending).resolves.toMatchObject({ status: 'cancelled' });
    expect(listGenerationProviders()[0].cancellationSupport).toBe('local-only');
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
