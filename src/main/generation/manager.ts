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
 * providers and the timeout, which also cancels the provider request.
 */

import { nanoid } from 'nanoid';
import type {
  GenerationProvider,
  GenerationRequest,
  GenerationResult,
  GenerationProgress,
  GenerationType,
} from './types';

const providers = new Map<string, GenerationProvider>();

const activeGenerations = new Map<string, { providerId: string }>();

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
  models: Record<GenerationType, string[]>;
}

export function listGenerationProviders(): GenerationProviderSummary[] {
  return Array.from(providers.values()).map((p) => ({
    id: p.id,
    name: p.name,
    supportedTypes: p.supportedTypes,
    configured: p.isConfigured(),
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
      `Generation timed out after ${Math.round(timeoutMs / 1000)}s and was cancelled`
      + ' — try a shorter duration or check the provider dashboard.',
    );
    this.name = 'GenerationTimeoutError';
  }
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
  activeGenerations.set(id, { providerId });
  opts.onStart?.(id);

  const timeoutMs = opts.timeoutMs ?? 600_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void provider.cancel(id);
      reject(new GenerationTimeoutError(id, timeoutMs));
    }, timeoutMs);
    timer.unref?.();
  });

  // A provider failure becomes a failed RESULT rather than a rejection: the
  // losing side of this race must never reject unhandled, and callers already
  // have to branch on status for cancellation anyway.
  const generation = provider.generate(full, opts.onProgress).catch(
    (err: unknown): GenerationResult & { id: string } => ({
      id,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    }),
  );

  try {
    return await Promise.race([generation, timedOut]);
  } finally {
    if (timer) clearTimeout(timer);
    activeGenerations.delete(id);
  }
}

export async function cancelGeneration(requestId: string): Promise<{ success: boolean; error?: string }> {
  const entry = activeGenerations.get(requestId);
  if (!entry) return { success: false, error: 'Not found' };
  const provider = providers.get(entry.providerId);
  if (provider) await provider.cancel(requestId);
  activeGenerations.delete(requestId);
  return { success: true };
}
