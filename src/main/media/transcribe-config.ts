/**
 * Persisted transcription endpoint override (#287 pluggable STT).
 *
 * When set, caption transcription routes to THIS OpenAI-compatible server
 * (self-hosted faster-whisper servers expose the same contract) instead of
 * borrowing the chat provider's host from #17/#140. Same ownership rule as
 * the silence controls: the main process owns it because both the agent tool
 * and the UI read it, and it is a preference rather than project data.
 *
 * The API key lives in plain JSON inside userData here (not DPAPI): the file
 * sits under the user's own profile directory, matching how self-hosted STT
 * users typically manage keys, while keeping the module Electron-optional
 * and unit-testable.
 */

import { app } from 'electron';
import Store from 'electron-store';

export interface TranscribeConfig {
  /** OpenAI-compatible base URL, e.g. http://localhost:8080/v1 */
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

const STORE_KEY = 'transcription';
const URL_RE = /^https?:\/\//i;

let store: Store | null = null;
let cached: TranscribeConfig | null = null;

function getStore(): Store | null {
  if (!app) return null;
  store ??= new Store({ name: 'palmier-transcribe-config' });
  return store;
}

function normalize(input: Partial<TranscribeConfig> | undefined | null): TranscribeConfig {
  const out: TranscribeConfig = {};
  const baseUrl = typeof input?.baseUrl === 'string' ? input.baseUrl.trim() : '';
  if (baseUrl && URL_RE.test(baseUrl)) out.baseUrl = baseUrl;
  const apiKey = typeof input?.apiKey === 'string' ? input.apiKey : '';
  if (apiKey.length > 0) out.apiKey = apiKey;
  const model = typeof input?.model === 'string' ? input.model.trim().slice(0, 64) : '';
  if (model.length > 0) out.model = model;
  return out;
}

/** The saved override, narrowed on read. Empty object = use the AI runtime. */
export function getTranscribeConfig(): TranscribeConfig {
  if (cached) return cached;
  try {
    const store_ = getStore();
    const raw = (store_?.get(STORE_KEY) ?? {}) as Partial<TranscribeConfig>;
    cached = normalize(raw);
  } catch {
    cached = {};
  }
  return cached;
}

export function setTranscribeConfig(patch: Partial<TranscribeConfig>): TranscribeConfig {
  const merged = normalize({ ...getTranscribeConfig(), ...patch });
  cached = merged;
  try {
    getStore()?.set(STORE_KEY, merged);
  } catch {
    // A failed write still governs this session.
  }
  return merged;
}

export function resetTranscribeConfigCache(): void {
  cached = null;
}
