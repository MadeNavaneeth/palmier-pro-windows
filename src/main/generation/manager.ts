/**
 * Generation Manager — provider registry and lifecycle, headless.
 *
 * Split from ./index so the Agent/MCP executor can run generations in the
 * main process without touching Electron IPC or key storage. The IPC shell
 * (index.ts) owns safeStorage persistence and event forwarding; everything
 * else goes through here, which keeps this module unit-testable with fake
 * providers.
 *
 * Contract: runGeneration resolves with the provider's result whatever the
 * outcome — callers branch on `status`. It rejects only for unknown/unconfigured
 * providers and the timeout. User cancellation resolves as `cancelled` so the
 * IPC shell can suppress completion; both cancellation paths abort local work
 * and attempt provider cancellation with the provider's own job id.
 */

import { nanoid } from 'nanoid';
import type {
  GenerationCancellationSupport,
  GenerationProvider,
  GenerationRequest,
  GenerationResult,
  GenerationProgress,
  GenerationType,
} from './types';

const providers = new Map<string, GenerationProvider>();

type ActiveGenerationState = 'running' | 'cancelled' | 'settled';

interface ActiveGeneration {
  providerId: string;
  providerRequestId?: string;
  state: ActiveGenerationState;
  controller: AbortController;
  resolveCancellation(result: GenerationResult & { id: string }): void;
  remoteCancellation?: RemoteCancellationOutcome;
  remoteCancellationPromise?: Promise<RemoteCancellationOutcome>;
  remoteCancellationError?: string;
}

const activeGenerations = new Map<string, ActiveGeneration>();

/**
 * Builtin registration happens in ./index (the Electron shell), because the
 * concrete provider classes pull `util` → `electron.app` transitively. This
 * module stays import-clean so the Agent executor can use it in tests.
 */

/** Test/DI seam: swap in a fresh registry (e.g. backed by fake providers). */
export function setGenerationProviders(next: Iterable<GenerationProvider>): void {
  providers.clear();
  for (const provider of next) providers.set(provider.id, provider);
}

export function registerGenerationProvider(provider: GenerationProvider): void {
  providers.set(provider.id, provider);
}

export function getGenerationProvider(id: string): GenerationProvider | undefined {
  return providers.get(id);
}

export interface GenerationProviderSummary {
  id: string;
  name: string;
  supportedTypes: GenerationType[];
  configured: boolean;
  cancellationSupport: GenerationCancellationSupport;
  models: Record<GenerationType, string[]>;
}

export function listGenerationProviders(): GenerationProviderSummary[] {
  return Array.from(providers.values()).map((p) => ({
    id: p.id,
    name: p.name,
    supportedTypes: p.supportedTypes,
    configured: p.isConfigured(),
    cancellationSupport: p.cancellationSupport ?? 'remote',
    models: {
      image: p.getModels('image'),
      video: p.getModels('video'),
      audio: p.getModels('audio'),
    },
  }));
}

/** Providers that both hold a key and support `type`, in registration order. */
export function configuredProvidersFor(type: GenerationType): GenerationProvider[] {
  return Array.from(providers.values()).filter(
    (p) => p.isConfigured() && p.supportedTypes.includes(type),
  );
}

export function configureGenerationProvider(id: string, apiKey: string): { success: boolean; error?: string } {
  const provider = providers.get(id);
  if (!provider) return { success: false, error: `Unknown provider: ${id}` };
  provider.configure(apiKey);
  return { success: true };
}

export class GenerationTimeoutError extends Error {
  constructor(
    readonly requestId: string,
    readonly timeoutMs: number,
  ) {
    super(
      `Generation timed out after ${Math.round(timeoutMs / 1000)}s and stopped waiting`
      + ' — remote cancellation was requested when supported; check the provider dashboard.',
    );
    this.name = 'GenerationTimeoutError';
  }
}

export type RemoteCancellationOutcome =
  | 'confirmed'
  | 'unsupported'
  | 'pending'
  | 'failed'
  | 'not-found';

export interface GenerationCancellationResult {
  /** Local cancellation is authoritative even when remote cancellation is not. */
  success: boolean;
  remoteCancellation: RemoteCancellationOutcome;
  error?: string;
}

function cancelledResult(id: string): GenerationResult & { id: string } {
  return { id, status: 'cancelled', error: 'Generation cancelled' };
}

function markCancelled(
  entry: ActiveGeneration,
  id: string,
  notifyRun: boolean,
): boolean {
  if (entry.state !== 'running') return false;
  entry.state = 'cancelled';
  if (notifyRun) entry.resolveCancellation(cancelledResult(id));
  return true;
}

async function attemptRemoteCancellation(
  entry: ActiveGeneration,
): Promise<RemoteCancellationOutcome> {
  if (entry.remoteCancellationPromise) return entry.remoteCancellationPromise;

  const provider = providers.get(entry.providerId);
  if (!provider) {
    entry.controller.abort();
    entry.remoteCancellation = 'failed';
    entry.remoteCancellationError = `Generation provider disappeared: ${entry.providerId}`;
    return entry.remoteCancellation;
  }

  if ((provider.cancellationSupport ?? 'remote') === 'local-only') {
    entry.controller.abort();
    entry.remoteCancellation = 'unsupported';
    return entry.remoteCancellation;
  }

  // Keep submission alive until its response yields the provider id; aborting
  // that fetch first could strand a remotely-started job with no cancel key.
  // The callback below retries this function and aborts local polling then.
  if (!entry.providerRequestId) return 'pending';

  entry.controller.abort();
  entry.remoteCancellationPromise = (async () => {
    try {
      await provider.cancel(entry.providerRequestId!);
      entry.remoteCancellation = 'confirmed';
      return entry.remoteCancellation;
    } catch (error: unknown) {
      entry.remoteCancellation = 'failed';
      entry.remoteCancellationError = error instanceof Error
        ? error.message
        : String(error);
      return entry.remoteCancellation;
    }
  })();
  return entry.remoteCancellationPromise;
}

export async function runGeneration(
  request: Omit<GenerationRequest, 'id'>,
  opts: {
    timeoutMs?: number;
    onProgress?: (progress: GenerationProgress) => void;
    /** Called synchronously once the request has an id — fire-and-forget callers need it for cancel. */
    onStart?: (id: string) => void;
  } = {},
): Promise<GenerationResult & { id: string }> {
  const providerId = request.provider;
  const provider = providers.get(providerId);
  if (!provider) throw new Error(`Unknown generation provider: ${providerId}`);
  if (!provider.isConfigured()) {
    throw new Error(
      `${provider.name} has no API key set. Add it under Settings → Generation.`,
    );
  }

  const id = nanoid();
  const full: GenerationRequest = { ...request, id };
  let resolveCancellation!: ActiveGeneration['resolveCancellation'];
  const cancellation = new Promise<GenerationResult & { id: string }>((resolve) => {
    resolveCancellation = resolve;
  });
  const entry: ActiveGeneration = {
    providerId,
    state: 'running',
    controller: new AbortController(),
    resolveCancellation,
  };
  activeGenerations.set(id, entry);
  opts.onStart?.(id);

  const reportProgress = opts.onProgress
    ? (progress: GenerationProgress) => {
        if (activeGenerations.get(id)?.state === 'running') opts.onProgress?.(progress);
      }
    : undefined;

  const timeoutMs = opts.timeoutMs ?? 600_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const timeoutError = new GenerationTimeoutError(id, timeoutMs);
      if (!markCancelled(entry, id, false)) return;
      void attemptRemoteCancellation(entry);
      // The renderer has no separate timeout event. A terminal progress event
      // releases its wait without pretending a late provider result completed.
      opts.onProgress?.({
        id,
        status: 'failed',
        percent: 100,
        message: timeoutError.message,
      });
      reject(timeoutError);
    }, timeoutMs);
    timer.unref?.();
  });

  // A provider failure becomes a failed RESULT rather than a rejection: the
  // losing side of this race must never reject unhandled, and callers already
  // have to branch on status for cancellation anyway.
  const generation = Promise.resolve()
    .then(() => provider.generate(full, reportProgress, {
      signal: entry.controller.signal,
      onProviderRequest: (providerRequestId: string) => {
        const current = activeGenerations.get(id);
        if (!current) return;
        current.providerRequestId = providerRequestId;
        if (current.state === 'cancelled') void attemptRemoteCancellation(current);
      },
    }))
    .catch((err: unknown): GenerationResult & { id: string } => ({
      id,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    }))
    .then((result) => {
      const current = activeGenerations.get(id);
      if (current?.state === 'cancelled') {
        current.state = 'settled';
        activeGenerations.delete(id);
        return cancelledResult(id);
      }
      if (current) {
        current.state = 'settled';
        activeGenerations.delete(id);
      }
      return result;
    });

  try {
    return await Promise.race([generation, cancellation, timedOut]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function cancelGeneration(requestId: string): Promise<GenerationCancellationResult> {
  const entry = activeGenerations.get(requestId);
  if (!entry || entry.state === 'settled') {
    return { success: true, remoteCancellation: 'not-found' };
  }

  markCancelled(entry, requestId, true);
  const remoteCancellation = await attemptRemoteCancellation(entry);
  return {
    success: true,
    remoteCancellation,
    ...(entry.remoteCancellationError ? { error: entry.remoteCancellationError } : {}),
  };
}
