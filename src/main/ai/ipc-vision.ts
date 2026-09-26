/**
 * Vision runtime resolution for `describe_media` (#118 AI half).
 *
 * Split out of `ipc.ts` so the tool executor can import it without pulling
 * the agent/IPC handler graph into unit tests. Reads the same
 * `palmier-ai-config` store the chat path uses: Anthropic first (Claude
 * vision is reliable), otherwise the first OpenAI-compatible provider whose
 * model passes the vision check. Null when nothing usable is configured.
 *
 * The description is user data sent to the user's own configured provider
 * only; this module only resolves which provider that is.
 */

import { app, safeStorage } from 'electron';
import Store from 'electron-store';
import { PROVIDER_PRESETS, presetById, validateProviderConfig } from '../../shared/ai/provider-config';
import { isVisionCapableModel, type VisionRuntime } from './describe';

let store: Store | null = null;

function getStore(): Store | null {
  try {
    if (!app) return null;
  } catch {
    return null;
  }
  store ??= new Store({ name: 'palmier-ai-config' });
  return store;
}

function isSafeProviderId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-z0-9-]{1,32}$/.test(id);
}

function decryptStoredKey(providerId: string): string {
  let encryptedKey: string | undefined;
  try {
    encryptedKey = getStore()?.get(`keys.${providerId}`) as string | undefined;
  } catch {
    return '';
  }
  if (!encryptedKey) return '';
  try {
    return safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(Buffer.from(encryptedKey, 'base64'))
      : encryptedKey;
  } catch {
    return '';
  }
}

export async function getVisionRuntime(): Promise<VisionRuntime | null> {
  // Anthropic first: every Claude model accepts images.
  const ordered = [
    'anthropic',
    ...PROVIDER_PRESETS.filter((p) => p.id !== 'anthropic').map((p) => p.id),
  ];
  for (const id of ordered) {
    if (!isSafeProviderId(id)) continue;
    const preset = presetById(id);
    if (!preset) continue;
    // The CLI transport has no HTTP vision endpoint for describe_media.
    if (preset.kind === 'codex-cli') continue;
    let stored: { kind?: unknown; baseUrl?: unknown; model?: unknown } | undefined;
    try {
      stored = getStore()?.get(`providers.${id}`) as typeof stored;
    } catch {
      stored = undefined;
    }
    const candidate = {
      kind: stored?.kind ?? preset?.kind,
      baseUrl: stored?.baseUrl ?? preset?.baseUrl,
      model: stored?.model ?? preset?.defaultModel,
    };
    const result = validateProviderConfig(candidate);
    if (!result.ok) continue;
    // Vision is served over HTTP; the CLI transport has no vision endpoint.
    if (result.config.kind !== 'anthropic' && result.config.kind !== 'openai-compatible') continue;
    const apiKey = decryptStoredKey(id);
    if (apiKey.length === 0 && preset.requiresApiKey) continue;
    if (!isVisionCapableModel(result.config.kind, result.config.model)) continue;
    if (result.config.kind === 'openai-compatible' && !result.config.baseUrl) continue;
    return {
      kind: result.config.kind,
      ...(result.config.baseUrl ? { baseUrl: result.config.baseUrl } : {}),
      apiKey,
      model: result.config.model,
      providerId: id,
    };
  }
  return null;
}
