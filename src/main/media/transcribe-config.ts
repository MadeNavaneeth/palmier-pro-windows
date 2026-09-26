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
import { isKnownLocalModel, normalizeSttEngine, type SttEngine } from './whisper-local';

export { normalizeSttEngine, type SttEngine };

export interface TranscribeConfig {
  /** OpenAI-compatible base URL, e.g. http://localhost:8080/v1 */
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  /**
   * Engine choice (#39 local half): `auto` prefers the local whisper.cpp
   * engine when its binary + model are present, then the custom endpoint,
   * then cloud BYOK. An explicit engine never falls back — it refuses with
   * an actionable message instead. Absent = `auto`.
   */
  engine?: SttEngine;
  /** Local whisper.cpp model id (catalog in ./whisper-local). Absent = base. */
  localModel?: string;
  /** Custom whisper-cli binary path override (e.g. win-arm64 own build). */
  localBinaryPath?: string;
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
  // Local-STT settings (#39) narrow the same way: unknown engine values and
  // model ids fall back to the defaults rather than reaching the runner, and
  // the binary override stays a short string (existence is checked at probe
  // time so the refusal can name the missing path).
  const engine = normalizeSttEngine(input?.engine);
  if (engine !== 'auto') out.engine = engine;
  const localModel = typeof input?.localModel === 'string' ? input.localModel.trim() : '';
  if (localModel && isKnownLocalModel(localModel)) out.localModel = localModel;
  const localBinaryPath = typeof input?.localBinaryPath === 'string' ? input.localBinaryPath.trim().slice(0, 512) : '';
  if (localBinaryPath.length > 0) out.localBinaryPath = localBinaryPath;
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
