/**
 * Local/offline transcription over a whisper.cpp `whisper-cli` binary (#39).
 *
 * The cloud half of #39 (OpenAI-compatible `/audio/transcriptions` over BYOK)
 * cannot work offline and always bills the user's key; this module is the
 * local half: a whisper.cpp binary plus ggml model files resolved under
 * Electron `userData`, spawned as a separate process in the main process
 * (never the renderer interaction path).
 *
 * Binary sourcing (evidence, checked 2026-09-19):
 * - ggml-org/whisper.cpp publishes no Windows CLI binaries with its releases
 *   and building from source would add a CMake/MSVC toolchain to CI, which
 *   the task forbids. npm-packaged binaries (whisper-node et al.) would bloat
 *   node_modules/the installer with a version-lagged copy, so they are out.
 * - Chosen: download-on-demand from jiang1997/whisper.cpp-release, whose
 *   GitHub Actions builds whisper.cpp per release for Linux/Windows/macOS.
 *   Latest release v1.8.4.1 (whisper.cpp v1.8.4) ships
 *   `whisper-1.8.4-windows-x64.zip` (37,802,904 bytes) with a publisher-side
 *   sha256, which is pinned below and verified after every download. The
 *   builder is third-party, so the digest pin doubles as tamper evidence; a
 *   mismatch refuses loudly rather than executing anything.
 * - No windows-arm64 asset is published there, so win-arm64 has no
 *   auto-download: status reports it explicitly and the user can point
 *   `localBinaryPath` at their own build (or any whisper-cli on PATH).
 *
 * Licenses: whisper.cpp is MIT. The ggml model files are conversions of
 * OpenAI Whisper weights (openai/whisper is MIT-licensed) distributed via
 * huggingface.co/ggerganov/whisper.cpp — re-check that repo's license file
 * if redistribution terms matter to you; we only download, never bundle.
 *
 * Engine contract (mirrors ./transcribe.ts): word-level timestamps in the
 * exact `WordTiming[]` shape `planCaptions` consumes, so local results lay
 * cues identically to cloud results. Word timings come from stdout bracket
 * lines (`-ml 1`, documented in the whisper.cpp README "Word-level timestamp"
 * section): `[00:00:00.320 --> 00:00:00.370]   And`. Multi-word segments
 * cannot occur with `-ml 1`, but punctuation-only tokens (",", ".") do, so
 * they merge into the previous word ("country" + "." -> "country.") instead
 * of becoming orphan cue words.
 *
 * Electron-free by construction: the userData directory is injected, and
 * spawn/fetch/fs access goes through seams so unit tests run with stubs
 * (no network, no binary, no models).
 */

import { execFile, spawn } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { createWriteStream, promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import type { WordTiming } from '../../shared/captions/planner';
import { normalizeLanguageHint } from '../../shared/stt/languages';
import type { TranscriptionResult } from '../ai/transcribe';

const execFileAsync = promisify(execFile);

/** Engine choice persisted in transcribe-config; `auto` prefers local. */
export type SttEngine = 'auto' | 'local' | 'custom' | 'cloud';

const STT_ENGINES: readonly string[] = ['auto', 'local', 'custom', 'cloud'];

export function normalizeSttEngine(input: unknown): SttEngine {
  return typeof input === 'string' && (STT_ENGINES as readonly string[]).includes(input)
    ? (input as SttEngine)
    : 'auto';
}

export interface WhisperLocalModel {
  id: string;
  file: string;
  /** Pre-download display + storage-cap accounting (see note below). */
  approxBytes: number;
  sizeLabel: string;
  url: string;
}

const MiB = 1024 * 1024;

/**
 * Multilingual (non-`.en`) models only: a per-job language hint is the #39
 * acceptance core, and English-only weights could not honour it. Disk/memory
 * figures are the whisper.cpp README table (tiny 75 MiB … medium 1.5 GiB);
 * large-v3-turbo is approximate and marked so. These numbers are shown BEFORE
 * download and feed the storage cap; download integrity itself is verified
 * against the server's Content-Length, not these approximations.
 */
const MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

function model(id: string, file: string, approxBytes: number, sizeLabel: string): WhisperLocalModel {
  return { id, file, approxBytes, sizeLabel, url: `${MODEL_BASE_URL}/${file}` };
}

export const WHISPER_LOCAL_MODELS: readonly WhisperLocalModel[] = [
  model('tiny', 'ggml-tiny.bin', 75 * MiB, '75 MB'),
  model('base', 'ggml-base.bin', 142 * MiB, '142 MB'),
  model('small', 'ggml-small.bin', 466 * MiB, '466 MB'),
  model('medium', 'ggml-medium.bin', 1578 * MiB, '1.5 GB'),
  model('large-v3-turbo', 'ggml-large-v3-turbo.bin', 1620 * MiB, '≈1.6 GB'),
];

export const DEFAULT_LOCAL_MODEL = 'base';

export function findLocalModel(modelId: unknown): WhisperLocalModel | null {
  return typeof modelId === 'string'
    ? (WHISPER_LOCAL_MODELS.find((m) => m.id === modelId) ?? null)
    : null;
}

export function isKnownLocalModel(modelId: unknown): modelId is string {
  return findLocalModel(modelId) !== null;
}

/** Pinned prebuilt binary release (see module doc for provenance). */
export const WHISPER_BINARY_RELEASE = {
  tag: 'v1.8.4.1',
  asset: 'whisper-1.8.4-windows-x64.zip',
  bytes: 37_802_904,
  sha256: '4b1b36343feb55ec3deace6a7dd18cc217f43a55e4ecce76ccd4ee3595c0b642',
  url: 'https://github.com/jiang1997/whisper.cpp-release/releases/download/v1.8.4.1/whisper-1.8.4-windows-x64.zip',
  sizeLabel: '≈36 MB',
} as const;

export const WHISPER_CLI_EXE = 'whisper-cli.exe';

/** Total bytes the local model directory may hold before downloads refuse. */
export const LOCAL_STT_STORAGE_CAP_BYTES = 6 * 1024 * 1024 * 1024;

/** Bounded wait for a local run, mirroring the generation timeout (600s). */
export const LOCAL_TRANSCRIBE_TIMEOUT_MS = 600_000;

const LOCAL_STT_DIRNAME = 'stt-local';

// ─── Paths ─────────────────────────────────────────────────────────────────

export interface LocalSttPaths {
  root: string;
  binDir: string;
  modelsDir: string;
  binaryPath: string;
  modelPath: (modelId: string) => string | null;
}

export function resolveLocalSttPaths(userDataDir: string): LocalSttPaths {
  const root = path.join(userDataDir, LOCAL_STT_DIRNAME);
  const binDir = path.join(root, 'bin');
  const modelsDir = path.join(root, 'models');
  return {
    root,
    binDir,
    modelsDir,
    binaryPath: path.join(binDir, WHISPER_CLI_EXE),
    modelPath: (modelId: string) => {
      const entry = findLocalModel(modelId);
      return entry ? path.join(modelsDir, entry.file) : null;
    },
  };
}

// ─── Binary discovery ──────────────────────────────────────────────────────

export type BinarySource = 'override' | 'user-data' | 'path';

export interface BinaryProbe {
  found: boolean;
  path: string | null;
  source: BinarySource | null;
  /** An override was configured but the file is absent (actionable refusal). */
  missingOverride: boolean;
}

export interface ProbeDeps {
  exists?: (p: string) => Promise<boolean>;
  findOnPath?: () => Promise<string | null>;
}

async function defaultExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** A user-installed whisper-cli reachable via PATH (scoop/winget/own build). */
async function defaultFindOnPath(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('where', ['whisper-cli']);
    const first = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0];
    return first ?? null;
  } catch {
    return null;
  }
}

export async function probeLocalBinary(
  opts: { userDataDir?: string | null; override?: string | null },
  deps: ProbeDeps = {},
): Promise<BinaryProbe> {
  const exists = deps.exists ?? defaultExists;
  const override = typeof opts.override === 'string' && opts.override.trim()
    ? opts.override.trim()
    : null;
  if (override) {
    if (await exists(override)) return { found: true, path: override, source: 'override', missingOverride: false };
    return { found: false, path: null, source: null, missingOverride: true };
  }
  if (opts.userDataDir) {
    const underData = resolveLocalSttPaths(opts.userDataDir).binaryPath;
    if (await exists(underData)) {
      return { found: true, path: underData, source: 'user-data', missingOverride: false };
    }
  }
  const onPath = await (deps.findOnPath ?? defaultFindOnPath)();
  if (onPath) return { found: true, path: onPath, source: 'path', missingOverride: false };
  return { found: false, path: null, source: null, missingOverride: false };
}

// ─── Arg building ──────────────────────────────────────────────────────────

/**
 * CLI argv for a run. The language is ALWAYS passed explicitly: the binary
 * default is English, and omitting `-l` would reintroduce the system-language
 * lock-in #39 is about. An unsupported code throws — the refusal must name
 * it, never map it to a neighbour.
 */
export function buildWhisperArgs(opts: {
  modelPath: string;
  wavPath: string;
  language?: unknown;
}): string[] {
  const lang = normalizeLanguageHint(opts.language ?? 'auto');
  if (lang === null) {
    throw new Error(
      `"${String(opts.language).trim()}" is not a whisper language code — pick one from the language list or leave it empty for auto-detect.`,
    );
  }
  return ['-m', opts.modelPath, '-f', opts.wavPath, '-l', lang, '-ml', '1', '-np'];
}

// ─── Stdout parsing ────────────────────────────────────────────────────────

const LINE_RE = /^\[(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})\.(\d{3})\]\s*(.*)$/;

/** Tokens that belong to the previous word, not a cue of their own. */
const TRAILING_PUNCT_RE = /^[,.!?:;…'"")\]}»ー、。]+$/u;

function toSec(h: string, m: string, s: string, ms: string): number {
  // Millisecond-rounded: raw float math reads "1.59" as 1.5899999999999999,
  // which would drift cue boundaries off the snapped word timings.
  return Math.round((Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000) * 1000) / 1000;
}

/**
 * whisper-cli `-ml 1` bracket lines → WordTiming[]. Malformed lines are
 * skipped (a stray log line must not corrupt neighbouring cues); empty
 * segments (the leading alignment line) are skipped; punctuation-only tokens
 * merge backward. Sorted defensively like the cloud path.
 */
export function parseWhisperStdout(stdout: string): WordTiming[] {
  const words: WordTiming[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const match = LINE_RE.exec(line);
    if (!match) continue;
    const startSec = toSec(match[1]!, match[2]!, match[3]!, match[4]!);
    const endSec = toSec(match[5]!, match[6]!, match[7]!, match[8]!);
    const text = (match[9] ?? '').trim();
    if (!text || !Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec < startSec) continue;
    const prev = words[words.length - 1];
    if (prev && TRAILING_PUNCT_RE.test(text)) {
      prev.word += text;
      prev.endSec = endSec;
    } else {
      words.push({ word: text, startSec, endSec });
    }
  }
  return words.sort((a, b) => a.startSec - b.startSec);
}

// ─── Engine resolution ─────────────────────────────────────────────────────

export interface SttConfigView {
  engine?: unknown;
  localModel?: unknown;
  localBinaryPath?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
}

export interface LocalAvailability {
  binaryPresent: boolean;
  binaryMissingOverride: boolean;
  modelId: string;
  modelPresent: boolean;
}

export type SttResolution =
  | { kind: 'local'; modelId: string }
  | { kind: 'custom' }
  | { kind: 'cloud' }
  | { kind: 'refusal'; error: string };

function refuseLanguage(language: unknown): string {
  return `"${String(language).trim()}" is not a whisper language code — pick one from the language list or leave it empty for auto-detect.`;
}

function localMissingError(local: LocalAvailability, entry: WhisperLocalModel | null): string {
  if (local.binaryMissingOverride) {
    return 'The configured local transcription binary was not found — fix the custom binary path under Captions → Engine, or clear it to use the downloaded binary.';
  }
  if (!local.binaryPresent) {
    return `The local transcription binary is not installed (whisper.cpp ${WHISPER_BINARY_RELEASE.tag}, Windows x64, ${WHISPER_BINARY_RELEASE.sizeLabel}). Download it under Captions → Engine → Local before transcribing — no audio leaves this machine.`;
  }
  const size = entry ? ` (≈${entry.sizeLabel})` : '';
  return `Local model "${local.modelId}"${size} is not downloaded. Download it under Captions → Engine → Local before transcribing.`;
}

/**
 * Engine choice with explicit degraded states. `requested` is the per-job
 * override (agent tool / IPC payload); otherwise the persisted config wins;
 * `auto` prefers local when fully available, then the custom endpoint, then
 * cloud BYOK. An explicit `local` NEVER falls back to cloud — that would
 * spend the user's money and leak audio unexpectedly — it refuses with an
 * actionable message instead. Same for every other explicit choice.
 */
export function resolveSttEngine(
  opts: { requested?: unknown; language?: unknown; cloudAvailable: boolean },
  config: SttConfigView,
  local: LocalAvailability,
): SttResolution {
  if (normalizeLanguageHint(opts.language ?? 'auto') === null) {
    return { kind: 'refusal', error: refuseLanguage(opts.language) };
  }
  const requested = normalizeSttEngine(opts.requested);
  const configured = normalizeSttEngine(config.engine);
  const effective = requested !== 'auto' ? requested : configured;

  const customConfigured = typeof config.baseUrl === 'string' && config.baseUrl.length > 0
    && typeof config.apiKey === 'string' && config.apiKey.length > 0;
  const localReady = local.binaryPresent && local.modelPresent;

  if (effective === 'local') {
    if (!localReady) {
      return { kind: 'refusal', error: localMissingError(local, findLocalModel(local.modelId)) };
    }
    return { kind: 'local', modelId: local.modelId };
  }
  if (effective === 'custom') {
    if (!customConfigured) {
      return {
        kind: 'refusal',
        error: 'The custom transcription server is selected but no server URL and API key are saved — add them under Captions → Engine, or switch the engine to Auto.',
      };
    }
    return { kind: 'custom' };
  }
  if (effective === 'cloud') {
    if (!opts.cloudAvailable) {
      return {
        kind: 'refusal',
        error: 'Cloud transcription is selected but no OpenAI-compatible provider with an API key is configured. Add one under AI Settings, or switch the engine to Auto/Local.',
      };
    }
    return { kind: 'cloud' };
  }
  if (localReady) return { kind: 'local', modelId: local.modelId };
  if (customConfigured) return { kind: 'custom' };
  if (opts.cloudAvailable) return { kind: 'cloud' };
  return {
    kind: 'refusal',
    error: 'No transcription engine is ready. Download a local model under Captions → Engine → Local (works offline), set a custom server, or add an AI provider key.',
  };
}

// ─── Local run ─────────────────────────────────────────────────────────────

export interface LocalTranscribeProgress {
  completedSec: number;
  totalSec: number | null;
  ratio: number | null;
}

export interface RunLocalOptions {
  userDataDir?: string | null;
  binaryOverride?: string | null;
  modelId?: string;
  audioPath: string;
  language?: unknown;
  /** Source duration for progress ratios; parsed from stderr when omitted. */
  durationSec?: number | null;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (p: LocalTranscribeProgress) => void;
}

export interface SpawnedProcess {
  stdout: { on(event: 'data', cb: (chunk: Buffer | string) => void): void };
  stderr: { on(event: 'data', cb: (chunk: Buffer | string) => void): void };
  on(event: 'error' | 'close', cb: (a?: unknown, b?: unknown) => void): void;
  kill(signal?: string): boolean;
  killed: boolean;
}

export interface RunLocalDeps extends ProbeDeps {
  convertToWav?: (src: string, dest: string) => Promise<void>;
  spawnFn?: (cmd: string, args: string[]) => SpawnedProcess;
}

async function defaultConvertToWav(src: string, dest: string): Promise<void> {
  // whisper-cli only reads 16-bit WAV (upstream README quick start), so every
  // library asset is normalised through the repo's FFmpeg first.
  await execFileAsync('ffmpeg', ['-y', '-i', src, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', dest]);
}

function defaultSpawnFn(cmd: string, args: string[]): SpawnedProcess {
  return spawn(cmd, args, { windowsHide: true }) as unknown as SpawnedProcess;
}

function stderrTail(stderr: string): string {
  return stderr.slice(-500).replace(/\s+/g, ' ').trim();
}

const SAMPLES_RE = /(\d+)\s+samples,\s*([\d.]+)\s*sec/;

export async function runLocalTranscription(
  opts: RunLocalOptions,
  deps: RunLocalDeps = {},
): Promise<TranscriptionResult> {
  const entry = findLocalModel(opts.modelId ?? DEFAULT_LOCAL_MODEL);
  if (!entry) {
    const known = WHISPER_LOCAL_MODELS.map((m) => m.id).join(', ');
    throw new Error(`Unknown local model "${String(opts.modelId)}" — choose one of: ${known}.`);
  }
  const lang = normalizeLanguageHint(opts.language ?? 'auto');
  if (lang === null) throw new Error(refuseLanguage(opts.language));

  const probe = await probeLocalBinary(
    { userDataDir: opts.userDataDir, override: opts.binaryOverride },
    deps,
  );
  if (!probe.found || !probe.path) {
    throw new Error(localMissingError({
      binaryPresent: false,
      binaryMissingOverride: probe.missingOverride,
      modelId: entry.id,
      modelPresent: false,
    }, entry));
  }
  const modelPath = opts.userDataDir
    ? resolveLocalSttPaths(opts.userDataDir).modelPath(entry.id)
    : null;
  if (modelPath && !(await (deps.exists ?? defaultExists)(modelPath))) {
    throw new Error(localMissingError({
      binaryPresent: true,
      binaryMissingOverride: false,
      modelId: entry.id,
      modelPresent: false,
    }, entry));
  }
  if (!modelPath) {
    throw new Error('Local transcription needs the desktop app directories, which are unavailable here.');
  }
  if (opts.signal?.aborted) throw new Error('Local transcription was cancelled — partial output discarded.');

  const wavPath = path.join(os.tmpdir(), `palmier-stt-${randomUUID()}.wav`);
  try {
    await (deps.convertToWav ?? defaultConvertToWav)(opts.audioPath, wavPath);
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not convert "${path.basename(opts.audioPath)}" to 16 kHz mono WAV for local transcription: ${detail}`,
    );
  }

  const label = `model "${entry.id}", language "${lang}"`;
  const timeoutMs = opts.timeoutMs ?? LOCAL_TRANSCRIBE_TIMEOUT_MS;
  let child: SpawnedProcess;
  try {
    child = (deps.spawnFn ?? defaultSpawnFn)(
      probe.path,
      buildWhisperArgs({ modelPath, wavPath, language: lang }),
    );
  } catch (err: unknown) {
    await fs.rm(wavPath, { force: true });
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Local transcription could not start the engine (${label}): ${detail}`);
  }

  // Monotonic progress from streamed segment end-times: whisper.cpp emits
  // bracket lines as it decodes, so the last end-time over the source
  // duration is a real ratio without depending on undocumented -pp formats.
  let stdout = '';
  let stderr = '';
  let totalSec: number | null = typeof opts.durationSec === 'number' && Number.isFinite(opts.durationSec)
    ? opts.durationSec
    : null;
  let lastCompleted = 0;
  const emit = (completed: number): void => {
    lastCompleted = Math.max(lastCompleted, completed);
    opts.onProgress?.({
      completedSec: lastCompleted,
      totalSec,
      ratio: totalSec && totalSec > 0 ? Math.min(1, lastCompleted / totalSec) : null,
    });
  };
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
    const words = parseWhisperStdout(stdout);
    if (words.length > 0) emit(words[words.length - 1]!.endSec);
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
    if (stderr.length > 32_768) stderr = stderr.slice(-32_768);
    if (totalSec === null) {
      const m = SAMPLES_RE.exec(stderr);
      if (m) emit(lastCompleted);
      if (m) totalSec = Number(m[2]);
    }
  });

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (err?: Error): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        if (err) reject(err);
        else resolve();
      };
      const kill = (): void => {
        try {
          if (!child.killed) child.kill('SIGKILL');
        } catch { /* already gone */ }
      };
      const timer = setTimeout(() => {
        kill();
        done(new Error(
          `Local transcription timed out after ${Math.round(timeoutMs / 1000)}s (${label}) — try a shorter asset or a smaller model.`,
        ));
      }, timeoutMs);
      timer.unref?.();
      const onAbort = (): void => {
        kill();
        done(new Error('Local transcription was cancelled — partial output discarded.'));
      };
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      child.on('error', (err: unknown) => {
        kill();
        const detail = err instanceof Error ? err.message : String(err);
        done(new Error(`Local transcription could not run the engine (${label}): ${detail}`));
      });
      child.on('close', (code: unknown, signal: unknown) => {
        if (code === 0) {
          done();
          return;
        }
        const tail = stderrTail(stderr);
        const cause = signal
          ? `killed by signal ${String(signal)}`
          : `exited with code ${String(code)}`;
        done(new Error(
          `Local transcription failed (${cause}, ${label})${tail ? `: ${tail}` : ' — no further detail on stderr.'}`,
        ));
      });
    });
  } finally {
    // No orphan process (killed above on every failure path) and no
    // half-written output: timings are parsed from stdout only, and the
    // converted WAV is temp by construction.
    try {
      if (!child.killed) child.kill('SIGKILL');
    } catch { /* already gone */ }
    await fs.rm(wavPath, { force: true });
  }

  const words = parseWhisperStdout(stdout);
  if (words.length === 0) {
    throw new Error(
      `Local transcription produced no word timings (${label}) — the audio may contain no detectable speech.`,
    );
  }
  return {
    text: words.map((w) => w.word).join(' '),
    words,
    segments: [{ startSec: words[0]!.startSec, endSec: words[words.length - 1]!.endSec, text: words.map((w) => w.word).join(' ') }],
    model: `local:${entry.id}`,
  };
}

// ─── Downloads ─────────────────────────────────────────────────────────────

export interface DownloadProgress {
  receivedBytes: number;
  totalBytes: number | null;
  ratio: number | null;
}

export interface FetchHeaders {
  get(name: string): string | null;
}

export interface FetchResult {
  ok: boolean;
  status: number;
  headers: FetchHeaders;
  body: AsyncIterable<Uint8Array> | null;
}

export type FetchImpl = (url: string, init?: { signal?: AbortSignal }) => Promise<FetchResult>;

function defaultFetchImpl(url: string, init?: { signal?: AbortSignal }): Promise<FetchResult> {
  return (globalThis.fetch as typeof fetch)(url, init).then((res) => ({
    ok: res.ok,
    status: res.status,
    headers: { get: (name: string) => res.headers.get(name) },
    body: res.body ? toAsyncIterable(res.body as ReadableStream<Uint8Array>) : null,
  }));
}

async function* toAsyncIterable(stream: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  if (Symbol.asyncIterator in (stream as object)) {
    yield* stream as AsyncIterable<Uint8Array>;
    return;
  }
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

export interface DownloadDeps {
  fetchImpl?: FetchImpl;
  measureUsedBytes?: (dir: string) => Promise<number>;
}

export async function measureDirBytes(dir: string): Promise<number> {
  try {
    const names = await fs.readdir(dir);
    let total = 0;
    for (const name of names) {
      try {
        total += (await fs.stat(path.join(dir, name))).size;
      } catch { /* raced deletion */ }
    }
    return total;
  } catch {
    return 0;
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / MiB)} MB`;
}

async function streamToFile(
  url: string,
  destPart: string,
  opts: { onProgress?: (p: DownloadProgress) => void; signal?: AbortSignal; fetchImpl: FetchImpl; hash?: boolean },
): Promise<{ bytes: number; sha256: string | null }> {
  const res = await opts.fetchImpl(url, opts.signal ? { signal: opts.signal } : undefined);
  if (!res.ok || !res.body) {
    throw new Error(`Download failed (HTTP ${res.status}) for ${url}.`);
  }
  const totalHeader = res.headers.get('content-length');
  const totalBytes = totalHeader !== null && /^\d+$/.test(totalHeader.trim())
    ? Number(totalHeader.trim())
    : null;
  const hasher = opts.hash ? createHash('sha256') : null;
  let received = 0;
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(destPart);
    out.on('error', reject);
    out.on('finish', () => resolve());
    (async () => {
      try {
        for await (const chunk of res.body!) {
          if (opts.signal?.aborted) throw new Error('Download cancelled — partial file discarded.');
          hasher?.update(chunk);
          received += chunk.byteLength;
          if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
          opts.onProgress?.({
            receivedBytes: received,
            totalBytes,
            ratio: totalBytes ? Math.min(1, received / totalBytes) : null,
          });
        }
        out.end();
      } catch (err) {
        out.destroy(err as Error);
        reject(err);
      }
    })();
  }).catch(async (err: unknown) => {
    await fs.rm(destPart, { force: true });
    throw err;
  });
  return { bytes: received, sha256: hasher?.digest('hex') ?? null };
}

/**
 * On-demand model download. The catalog size is shown BEFORE any byte is
 * fetched (the UI renders `sizeLabel` up front) and the storage cap is
 * enforced before starting; integrity is verified against the server's
 * Content-Length plus a sanity floor, and the file lands atomically
 * (.part → rename) so a killed download never leaves a corrupt model.
 */
export async function downloadLocalModel(
  userDataDir: string,
  modelId: string,
  opts: { onProgress?: (p: DownloadProgress) => void; signal?: AbortSignal } = {},
  deps: DownloadDeps = {},
): Promise<{ path: string; bytes: number; alreadyPresent: boolean }> {
  const entry = findLocalModel(modelId);
  if (!entry) {
    throw new Error(`Unknown local model "${String(modelId)}" — choose one of: ${WHISPER_LOCAL_MODELS.map((m) => m.id).join(', ')}.`);
  }
  const paths = resolveLocalSttPaths(userDataDir);
  await fs.mkdir(paths.modelsDir, { recursive: true });
  const dest = paths.modelPath(entry.id)!;
  try {
    // Existence alone means present: downloads land atomically (.part →
    // rename), so dest is either a complete model or absent — never partial.
    const stat = await fs.stat(dest);
    return { path: dest, bytes: stat.size, alreadyPresent: true };
  } catch { /* not downloaded */ }

  const used = await (deps.measureUsedBytes ?? measureDirBytes)(paths.modelsDir);
  if (used + entry.approxBytes > LOCAL_STT_STORAGE_CAP_BYTES) {
    throw new Error(
      `Local model storage is full (${formatBytes(used)} of ${formatBytes(LOCAL_STT_STORAGE_CAP_BYTES)} used) — remove an unused model before downloading "${entry.id}" (${entry.sizeLabel}).`,
    );
  }
  const part = `${dest}.part`;
  const { bytes } = await streamToFile(entry.url, part, {
    onProgress: opts.onProgress,
    signal: opts.signal,
    fetchImpl: deps.fetchImpl ?? defaultFetchImpl,
  });
  if (bytes < MiB) {
    await fs.rm(part, { force: true });
    throw new Error(`Downloaded model "${entry.id}" is only ${formatBytes(bytes)} — the download was truncated.`);
  }
  await fs.rename(part, dest);
  return { path: dest, bytes, alreadyPresent: false };
}

/** Remove a downloaded model file (frees storage under the cap). */
export async function deleteLocalModel(userDataDir: string, modelId: string): Promise<{ freed: boolean }> {
  const dest = resolveLocalSttPaths(userDataDir).modelPath(modelId);
  if (!dest) throw new Error(`Unknown local model "${String(modelId)}".`);
  try {
    await fs.rm(dest, { force: true });
    return { freed: true };
  } catch {
    return { freed: false };
  }
}

/** Default zip extraction via built-in Windows Expand-Archive (no new dep). */
async function defaultExtractZip(zipPath: string, destDir: string): Promise<void> {
  try {
    await execFileAsync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`,
    ]);
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not unpack the transcription binary: ${detail}`);
  }
}

/**
 * On-demand binary download (win-x64 only — no windows-arm64 asset is
 * published upstream, see module doc). Verified against BOTH the pinned byte
 * count and the publisher sha256 before anything executes; the archive is
 * removed after extraction.
 */
export async function downloadLocalBinary(
  userDataDir: string,
  opts: { onProgress?: (p: DownloadProgress) => void; signal?: AbortSignal } = {},
  deps: DownloadDeps & { extractZip?: (zipPath: string, destDir: string) => Promise<void> } = {},
): Promise<{ path: string; alreadyPresent: boolean }> {
  if (process.arch !== 'x64') {
    throw new Error(
      `No prebuilt transcription binary is published for Windows ${process.arch} — install your own whisper.cpp build and point the custom binary path at whisper-cli.exe under Captions → Engine.`,
    );
  }
  const paths = resolveLocalSttPaths(userDataDir);
  await fs.mkdir(paths.binDir, { recursive: true });
  try {
    await fs.access(paths.binaryPath);
    return { path: paths.binaryPath, alreadyPresent: true };
  } catch { /* not installed */ }

  const zipPath = path.join(paths.binDir, WHISPER_BINARY_RELEASE.asset);
  const part = `${zipPath}.part`;
  const { bytes, sha256 } = await streamToFile(WHISPER_BINARY_RELEASE.url, part, {
    onProgress: opts.onProgress,
    signal: opts.signal,
    fetchImpl: deps.fetchImpl ?? defaultFetchImpl,
    hash: true,
  });
  if (bytes !== WHISPER_BINARY_RELEASE.bytes) {
    await fs.rm(part, { force: true });
    throw new Error(
      `The transcription binary download was truncated (${formatBytes(bytes)} of ${WHISPER_BINARY_RELEASE.sizeLabel}) — try again.`,
    );
  }
  if (sha256 !== WHISPER_BINARY_RELEASE.sha256) {
    await fs.rm(part, { force: true });
    throw new Error(
      'The transcription binary failed checksum verification — refusing to run it. Try again; if it persists, the upstream release changed.',
    );
  }
  await fs.rename(part, zipPath);
  try {
    await (deps.extractZip ?? defaultExtractZip)(zipPath, paths.binDir);
  } finally {
    await fs.rm(zipPath, { force: true });
  }
  const placed = await placeExtractedBinary(paths.binDir);
  return { path: placed, alreadyPresent: false };
}

/**
 * Surface whisper-cli.exe at the top of `binDir`. The release archive nests
 * its payload (exe + sibling libraries) one level deep, so the whole
 * directory lifts up — copying the exe alone would strand its DLLs.
 */
export async function placeExtractedBinary(binDir: string): Promise<string> {
  const binaryPath = path.join(binDir, WHISPER_CLI_EXE);
  const nested = await findWhisperExe(binDir);
  if (!nested) {
    throw new Error('The transcription binary archive did not contain whisper-cli.exe.');
  }
  if (nested !== binaryPath) {
    const nestedDir = path.dirname(nested);
    for (const name of await fs.readdir(nestedDir)) {
      await fs.rename(path.join(nestedDir, name), path.join(binDir, name));
    }
    await fs.rm(nestedDir, { recursive: true, force: true });
  }
  return binaryPath;
}

async function findWhisperExe(dir: string): Promise<string | null> {
  const direct = path.join(dir, WHISPER_CLI_EXE);
  try {
    await fs.access(direct);
    return direct;
  } catch { /* nested */ }
  try {
    const names = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of names) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(dir, entry.name, WHISPER_CLI_EXE);
      try {
        await fs.access(candidate);
        return candidate;
      } catch { /* keep looking */ }
    }
  } catch { /* unreadable */ }
  return null;
}

// ─── Status (setup UI) ─────────────────────────────────────────────────────

export interface LocalModelStatus {
  id: string;
  sizeLabel: string;
  approxBytes: number;
  downloaded: boolean;
  bytesOnDisk: number;
}

export interface LocalSttStatus {
  arch: string;
  binary: {
    present: boolean;
    path: string | null;
    source: BinarySource | null;
    missingOverride: boolean;
    download: {
      url: string;
      bytes: number;
      sizeLabel: string;
      sha256: string;
    } | null;
  };
  models: LocalModelStatus[];
  storage: { usedBytes: number; capBytes: number };
}

export async function getLocalSttStatus(
  userDataDir: string,
  opts: { override?: string | null } = {},
  deps: ProbeDeps = {},
): Promise<LocalSttStatus> {
  const paths = resolveLocalSttPaths(userDataDir);
  const probe = await probeLocalBinary({ userDataDir, override: opts.override }, deps);
  const models: LocalModelStatus[] = [];
  for (const entry of WHISPER_LOCAL_MODELS) {
    let bytesOnDisk = 0;
    try {
      bytesOnDisk = (await fs.stat(paths.modelPath(entry.id)!)).size;
    } catch { /* absent */ }
    models.push({
      id: entry.id,
      sizeLabel: entry.sizeLabel,
      approxBytes: entry.approxBytes,
      downloaded: bytesOnDisk > MiB,
      bytesOnDisk,
    });
  }
  const usedBytes = await measureDirBytes(paths.modelsDir);
  return {
    arch: process.arch,
    binary: {
      present: probe.found,
      path: probe.path,
      source: probe.source,
      missingOverride: probe.missingOverride,
      download: process.arch === 'x64'
        ? {
          url: WHISPER_BINARY_RELEASE.url,
          bytes: WHISPER_BINARY_RELEASE.bytes,
          sizeLabel: WHISPER_BINARY_RELEASE.sizeLabel,
          sha256: WHISPER_BINARY_RELEASE.sha256,
        }
        : null,
    },
    models,
    storage: { usedBytes, capBytes: LOCAL_STT_STORAGE_CAP_BYTES },
  };
}
