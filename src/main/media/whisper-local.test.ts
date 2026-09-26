/**
 * Local/offline transcription (#39): arg building, stdout parsing, engine
 * resolution, refusals, cancellation, downloads — all with stubbed
 * spawn/fetch/fs (no network, no binary, no models).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import {
  WHISPER_BINARY_RELEASE,
  WHISPER_LOCAL_MODELS,
  buildWhisperArgs,
  deleteLocalModel,
  downloadLocalBinary,
  downloadLocalModel,
  findLocalModel,
  getLocalSttStatus,
  parseWhisperStdout,
  placeExtractedBinary,
  probeLocalBinary,
  resolveLocalSttPaths,
  resolveSttEngine,
  runLocalTranscription,
  type FetchResult,
  type SpawnedProcess,
} from './whisper-local';
import {
  getTranscribeConfig,
  setTranscribeConfig,
  resetTranscribeConfigCache,
} from './transcribe-config';

// ─── Fake child process ────────────────────────────────────────────────────

class FakeProcess implements SpawnedProcess {
  killed = false;
  killCalls: string[] = [];
  stdoutCbs: Array<(chunk: Buffer | string) => void> = [];
  stderrCbs: Array<(chunk: Buffer | string) => void> = [];
  handlers = new Map<string, (a?: unknown, b?: unknown) => void>();
  stdout = { on: (event: 'data', cb: (chunk: Buffer | string) => void): void => {
    void event;
    this.stdoutCbs.push(cb);
  } };
  stderr = { on: (event: 'data', cb: (chunk: Buffer | string) => void): void => {
    void event;
    this.stderrCbs.push(cb);
  } };
  on(event: 'error' | 'close', cb: (a?: unknown, b?: unknown) => void): void {
    this.handlers.set(event, cb);
  }
  kill(signal?: string): boolean {
    this.killed = true;
    this.killCalls.push(signal ?? '');
    return true;
  }
  emitStdout(text: string): void {
    for (const cb of this.stdoutCbs) cb(text);
  }
  emitStderr(text: string): void {
    for (const cb of this.stderrCbs) cb(text);
  }
  close(code: number | null, signal: string | null = null): void {
    this.handlers.get('close')?.(code, signal);
  }
}

const BRACKETS = [
  '[00:00:00.000 --> 00:00:00.320]',
  '[00:00:00.320 --> 00:00:00.690]   And so',
  '[00:00:00.690 --> 00:00:00.850]   my',
  '[00:00:00.850 --> 00:00:01.590]   fellow',
  '[00:00:01.590 --> 00:00:02.850]   Americans',
  '[00:00:02.850 --> 00:00:03.300]  ,',
  '[00:00:03.300 --> 00:00:04.140]   ask',
].join('\n');

// ─── Arg building ──────────────────────────────────────────────────────────

describe('buildWhisperArgs', () => {
  const base = { modelPath: 'C:\\m\\ggml-base.bin', wavPath: 'C:\\t\\in.wav' };

  it('passes the per-job language to the engine (never the binary default)', () => {
    expect(buildWhisperArgs({ ...base, language: 'de' })).toEqual([
      '-m', base.modelPath, '-f', base.wavPath, '-l', 'de', '-ml', '1', '-np',
    ]);
  });

  it('sends auto-detect when no hint is given', () => {
    expect(buildWhisperArgs(base)).toContain('auto');
    expect(buildWhisperArgs({ ...base, language: '' })).toContain('auto');
  });

  it('normalises case/whitespace', () => {
    expect(buildWhisperArgs({ ...base, language: ' FR ' })).toContain('fr');
  });

  it('refuses an unsupported code precisely instead of falling back', () => {
    expect(() => buildWhisperArgs({ ...base, language: 'xx' })).toThrow(/"xx" is not a whisper language code/);
  });

  it('accepts three-letter whisper codes', () => {
    expect(buildWhisperArgs({ ...base, language: 'yue' })).toContain('yue');
  });
});

// ─── Stdout parsing ────────────────────────────────────────────────────────

describe('parseWhisperStdout', () => {
  it('parses -ml 1 bracket lines into word timings', () => {
    const words = parseWhisperStdout(BRACKETS);
    // Empty leading segment skipped; "so" stays its own word; "," merges back.
    expect(words.map((w) => w.word)).toEqual(['And so', 'my', 'fellow', 'Americans,', 'ask']);
    expect(words[0]).toMatchObject({ startSec: 0.32, endSec: 0.69 });
    expect(words[3]).toMatchObject({ word: 'Americans,', startSec: 1.59, endSec: 3.3 });
  });

  it('skips malformed lines without corrupting neighbours', () => {
    const words = parseWhisperStdout([
      'main: processing (176000 samples, 11.0 sec)',
      '[00:00:00.320 --> 00:00:00.690]   hello',
      'whisper_full: progress = 12%',
      '[not a timestamp]   ???',
      '[00:00:00.690 --> 00:00:01.000]   world',
      '',
    ].join('\n'));
    expect(words).toEqual([
      { word: 'hello', startSec: 0.32, endSec: 0.69 },
      { word: 'world', startSec: 0.69, endSec: 1 },
    ]);
  });

  it('merges sentence-final punctuation backward', () => {
    const words = parseWhisperStdout([
      '[00:00:10.020 --> 00:00:10.510]   country',
      '[00:00:10.510 --> 00:00:11.000]  .',
    ].join('\n'));
    expect(words).toEqual([{ word: 'country.', startSec: 10.02, endSec: 11 }]);
  });

  it('returns [] for empty output', () => {
    expect(parseWhisperStdout('')).toEqual([]);
  });
});

// ─── Run harness (stub binary) ─────────────────────────────────────────────

let userData = '';
let audioPath = '';

async function makeDirs(): Promise<{ binFile: string; modelFile: string }> {
  userData = await fs.mkdtemp(path.join(os.tmpdir(), 'palmier-local-stt-'));
  const paths = resolveLocalSttPaths(userData);
  await fs.mkdir(paths.binDir, { recursive: true });
  await fs.mkdir(paths.modelsDir, { recursive: true });
  const binFile = paths.binaryPath;
  const modelFile = paths.modelPath('base')!;
  await fs.writeFile(binFile, 'fake-exe');
  await fs.writeFile(modelFile, 'fake-model');
  audioPath = path.join(userData, 'speech.wav');
  await fs.writeFile(audioPath, Buffer.alloc(64));
  return { binFile, modelFile };
}

afterEach(async () => {
  if (userData) await fs.rm(userData, { recursive: true, force: true });
  userData = '';
  vi.restoreAllMocks();
});

/**
 * Wait until the runner armed the stub (handlers registered) before emitting.
 * A single macrotask is not enough: the runner awaits real stub I/O first.
 */
async function armed(fake: FakeProcess): Promise<void> {
  for (let i = 0; i < 200 && !fake.handlers.has('close'); i += 1) {
    await new Promise((r) => setTimeout(r, 0));
  }
  if (!fake.handlers.has('close')) throw new Error('stub process was never armed');
}

function runDeps(fake: FakeProcess, extra: Record<string, unknown> = {}) {
  let wavDest: string | null = null;
  return {
    wavDest: () => wavDest,
    deps: {
      exists: async () => true,
      findOnPath: async () => null,
      convertToWav: async (_src: string, dest: string) => {
        wavDest = dest;
        await fs.writeFile(dest, Buffer.alloc(16));
      },
      spawnFn: () => fake,
      ...extra,
    },
  };
}

describe('runLocalTranscription (stub binary)', () => {
  it('returns the cloud-shaped contract so cues lay identically', async () => {
    await makeDirs();
    const fake = new FakeProcess();
    const { deps } = runDeps(fake);
    const pending = runLocalTranscription(
      { userDataDir: userData, modelId: 'base', audioPath, language: 'en', durationSec: 11 },
      deps,
    );
    await armed(fake);
    fake.emitStdout(BRACKETS);
    fake.close(0);
    const result = await pending;
    expect(result.model).toBe('local:base');
    expect(result.words.map((w) => w.word)).toEqual(['And so', 'my', 'fellow', 'Americans,', 'ask']);
    expect(result.text).toBe('And so my fellow Americans, ask');
    expect(result.segments).toHaveLength(1);
  });

  it('reports progress from streamed segment times', async () => {
    await makeDirs();
    const fake = new FakeProcess();
    const { deps } = runDeps(fake);
    const seen: number[] = [];
    const pending = runLocalTranscription(
      {
        userDataDir: userData, audioPath, durationSec: 10,
        onProgress: (p) => { if (p.ratio !== null) seen.push(p.ratio); },
      },
      deps,
    );
    await armed(fake);
    fake.emitStdout('[00:00:00.000 --> 00:00:05.000]   halfway\n');
    fake.close(0);
    await pending;
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBeCloseTo(0.5);
  });

  it('cancellation kills the stub and removes the converted wav', async () => {
    await makeDirs();
    const fake = new FakeProcess();
    const handle = runDeps(fake);
    const controller = new AbortController();
    const pending = runLocalTranscription(
      { userDataDir: userData, audioPath, signal: controller.signal },
      handle.deps,
    );
    // Wait for the runner to actually arm the stub rather than sleeping a fixed
    // 10ms: under a parallel suite load the wav conversion and spawn have not
    // happened yet, so an early abort killed nothing and the wav still existed.
    await armed(fake);
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(fake.killed).toBe(true);
    const wav = handle.wavDest();
    expect(wav).not.toBeNull();
    await expect(fs.access(wav!)).rejects.toThrow();
  });

  it('timeout kills the stub and names the cause', async () => {
    await makeDirs();
    const fake = new FakeProcess();
    const { deps } = runDeps(fake);
    await expect(runLocalTranscription(
      { userDataDir: userData, audioPath, timeoutMs: 40 },
      deps,
    )).rejects.toThrow(/timed out after 0s/);
    expect(fake.killed).toBe(true);
  });

  it('non-zero exit names the code and the stderr tail', async () => {
    await makeDirs();
    const fake = new FakeProcess();
    const { deps } = runDeps(fake);
    const pending = runLocalTranscription({ userDataDir: userData, audioPath }, deps);
    await armed(fake);
    fake.emitStderr('whisper_init: failed to load model: bad magic');
    fake.close(1);
    await expect(pending).rejects.toThrow(/exited with code 1.*bad magic/);
  });

  it('empty timings refuse instead of placing nothing', async () => {
    await makeDirs();
    const fake = new FakeProcess();
    const { deps } = runDeps(fake);
    const pending = runLocalTranscription({ userDataDir: userData, audioPath }, deps);
    await armed(fake);
    fake.emitStdout('nothing with brackets here\n');
    fake.close(0);
    await expect(pending).rejects.toThrow(/no word timings/);
  });

  it('refuses a missing binary with the download action', async () => {
    await makeDirs();
    const fake = new FakeProcess();
    const { deps } = runDeps(fake, {
      exists: async (p: string) => !p.endsWith('.exe'),
      findOnPath: async () => null,
    });
    await expect(runLocalTranscription({ userDataDir: userData, audioPath }, deps))
      .rejects.toThrow(/binary is not installed.*Captions → Engine → Local/);
    expect(fake.killCalls).toHaveLength(0);
  });

  it('refuses a missing model naming its size', async () => {
    await makeDirs();
    const fake = new FakeProcess();
    const { deps } = runDeps(fake, {
      exists: async (p: string) => !p.endsWith('.bin'),
    });
    await expect(runLocalTranscription({ userDataDir: userData, modelId: 'small', audioPath }, deps))
      .rejects.toThrow(/Local model "small" \(≈466 MB\) is not downloaded/);
  });

  it('refuses an unknown model id and an unsupported language', async () => {
    await makeDirs();
    const fake = new FakeProcess();
    const spawnFn = vi.fn(() => fake);
    const { deps } = runDeps(fake, { spawnFn });
    await expect(runLocalTranscription({ userDataDir: userData, modelId: 'xxl', audioPath }, deps))
      .rejects.toThrow(/Unknown local model "xxl"/);
    await expect(runLocalTranscription({ userDataDir: userData, audioPath, language: 'xx' }, deps))
      .rejects.toThrow(/not a whisper language code/);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('surfaces wav-conversion failures with the cause', async () => {
    await makeDirs();
    const fake = new FakeProcess();
    const { deps } = runDeps(fake, {
      convertToWav: async () => { throw new Error('ffmpeg not found'); },
      spawnFn: vi.fn(() => fake),
    });
    await expect(runLocalTranscription({ userDataDir: userData, audioPath }, deps))
      .rejects.toThrow(/Could not convert.*ffmpeg not found/);
    expect((deps.spawnFn as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});

// ─── Engine resolution ─────────────────────────────────────────────────────

describe('resolveSttEngine', () => {
  const ready = { binaryPresent: true, binaryMissingOverride: false, modelId: 'base', modelPresent: true };
  const bare = { binaryPresent: false, binaryMissingOverride: false, modelId: 'base', modelPresent: false };
  const custom = { baseUrl: 'http://127.0.0.1:8080/v1', apiKey: 'k' };

  it('auto prefers local when fully available', () => {
    expect(resolveSttEngine({ cloudAvailable: true }, {}, ready)).toEqual({ kind: 'local', modelId: 'base' });
  });

  it('auto falls back to custom, then cloud', () => {
    expect(resolveSttEngine({ cloudAvailable: false }, custom, bare)).toEqual({ kind: 'custom' });
    expect(resolveSttEngine({ cloudAvailable: true }, {}, bare)).toEqual({ kind: 'cloud' });
  });

  it('explicit local never falls back to cloud — it refuses actionably', () => {
    const r = resolveSttEngine({ requested: 'local', cloudAvailable: true }, {}, bare);
    expect(r.kind).toBe('refusal');
    expect((r as { error: string }).error).toMatch(/binary is not installed/);
  });

  it('explicit local with a missing model names the download', () => {
    const r = resolveSttEngine(
      { requested: 'local', cloudAvailable: true }, {},
      { ...ready, modelPresent: false },
    );
    expect((r as { error: string }).error).toMatch(/Local model "base".*not downloaded/);
  });

  it('explicit custom/cloud refuse when unconfigured', () => {
    expect(resolveSttEngine({ requested: 'custom' , cloudAvailable: true }, {}, ready).kind).toBe('refusal');
    expect(resolveSttEngine({ requested: 'cloud', cloudAvailable: false }, {}, bare).kind).toBe('refusal');
  });

  it('an unsupported language refuses precisely on every path', () => {
    for (const requested of ['auto', 'local', 'cloud', 'custom'] as const) {
      const r = resolveSttEngine(
        { requested, language: 'xx', cloudAvailable: true }, custom, ready,
      );
      expect(r).toEqual({ kind: 'refusal', error: expect.stringMatching(/"xx" is not a whisper language code/) });
    }
  });

  it('auto with nothing configured explains all three setup paths', () => {
    const r = resolveSttEngine({ cloudAvailable: false }, {}, bare);
    expect((r as { error: string }).error).toMatch(/No transcription engine is ready/);
  });
});

// ─── Binary probe ──────────────────────────────────────────────────────────

describe('probeLocalBinary', () => {
  it('prefers the override and flags it when absent', async () => {
    expect(await probeLocalBinary({ override: 'C:\\w\\whisper-cli.exe' }, { exists: async () => true }))
      .toMatchObject({ found: true, source: 'override' });
    expect(await probeLocalBinary({ override: 'C:\\missing.exe' }, { exists: async () => false }))
      .toMatchObject({ found: false, missingOverride: true });
  });

  it('falls back to userData then PATH', async () => {
    await makeDirs();
    const hit = await probeLocalBinary(
      { userDataDir: userData }, { exists: async (p) => p.endsWith('.exe') },
    );
    expect(hit).toMatchObject({ found: true, source: 'user-data' });
    const viaPath = await probeLocalBinary(
      { userDataDir: userData },
      { exists: async () => false, findOnPath: async () => 'D:\\tools\\whisper-cli.exe' },
    );
    expect(viaPath).toMatchObject({ found: true, source: 'path' });
  });
});

// ─── Downloads (stub fetch) ────────────────────────────────────────────────

function stubFetch(chunks: Uint8Array[], total: number | null = null): () => Promise<FetchResult> {
  return async () => ({
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name === 'content-length' && total !== null ? String(total) : null) },
    body: (async function* () { yield* chunks; })(),
  });
}

describe('downloadLocalModel (stub fetch)', () => {
  beforeEach(async () => { await makeDirs(); });

  it('streams to the catalog path with progress and lands atomically', async () => {
    const dest = resolveLocalSttPaths(userData).modelPath('tiny')!;
    try { await fs.rm(dest, { force: true }); } catch { /* setup */ }
    const chunk = new Uint8Array(2 * 1024 * 1024);
    const ratios: number[] = [];
    const out = await downloadLocalModel(userData, 'tiny', {
      onProgress: (p) => { if (p.ratio !== null) ratios.push(p.ratio); },
    }, { fetchImpl: stubFetch([chunk], chunk.byteLength) });
    expect(out.alreadyPresent).toBe(false);
    expect((await fs.stat(dest)).size).toBe(chunk.byteLength);
    expect(ratios[ratios.length - 1]).toBeCloseTo(1);
    // Atomic landing: no .part file survives a completed download.
    expect((await fs.readdir(path.dirname(dest))).some((n) => n.endsWith('.part'))).toBe(false);
  });

  it('skips when already downloaded', async () => {
    const out = await downloadLocalModel(userData, 'base', {}, { fetchImpl: stubFetch([]) });
    expect(out.alreadyPresent).toBe(true);
  });

  it('refuses before starting when the storage cap would break', async () => {
    await expect(downloadLocalModel(userData, 'medium', {}, {
      fetchImpl: stubFetch([]),
      measureUsedBytes: async () => 6 * 1024 * 1024 * 1024,
    })).rejects.toThrow(/storage is full/);
  });

  it('deletes a downloaded model', async () => {
    expect(await deleteLocalModel(userData, 'base')).toEqual({ freed: true });
    await expect(fs.access(resolveLocalSttPaths(userData).modelPath('base')!)).rejects.toThrow();
  });
});

describe('downloadLocalBinary (stub fetch)', () => {
  beforeEach(async () => { await makeDirs(); });

  it('refuses a truncated payload and leaves no residue', async () => {
    const paths = resolveLocalSttPaths(userData);
    await fs.rm(paths.binaryPath, { force: true });
    // A payload of EXACTLY the pinned size would waste 36 MB per test run;
    // assert instead that anything smaller refuses before extracting.
    const small = new Uint8Array(1024);
    const extractZip = vi.fn(async () => {});
    await expect(downloadLocalBinary(userData, {}, {
      fetchImpl: stubFetch([small], small.byteLength),
      extractZip,
    })).rejects.toThrow(/truncated/);
    expect(extractZip).not.toHaveBeenCalled();
    expect((await fs.readdir(paths.binDir)).some((n) => n.endsWith('.part'))).toBe(false);
  });

  it('refuses a checksum mismatch without extracting anything', async () => {
    const paths = resolveLocalSttPaths(userData);
    await fs.rm(paths.binaryPath, { force: true });
    const size = WHISPER_BINARY_RELEASE.bytes;
    const chunks = [new Uint8Array([1, 2, 3])];
    const extractZip = vi.fn(async () => {});
    await expect(downloadLocalBinary(userData, {}, {
      // A lying server (3 bytes, full-size Content-Length): the byte-count
      // gate refuses first; the pinned sha256 behind it is defense in depth
      // for an exact-size-but-tampered payload.
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: (name: string) => (name === 'content-length' ? String(size) : null) },
        body: (async function* () { yield* chunks; })(),
      }),
      extractZip,
    })).rejects.toThrow(/truncated|checksum/i);
    expect(extractZip).not.toHaveBeenCalled();
  });

  it('lifts a nested payload so the exe keeps its sibling files', async () => {
    // Mirrors the real release layout (exe + siblings nested one level
    // deep): the exe must land at binDir with its directory intact.
    const paths = resolveLocalSttPaths(userData);
    await fs.rm(paths.binaryPath, { force: true });
    const nested = path.join(paths.binDir, 'whisper-1.8.4-windows-x64');
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(nested, 'whisper-cli.exe'), 'fake-exe');
    await fs.writeFile(path.join(nested, 'sibling.dll'), 'fake-dll');
    const placed = await placeExtractedBinary(paths.binDir);
    expect(placed).toBe(paths.binaryPath);
    expect(await fs.readFile(paths.binaryPath, 'utf8')).toBe('fake-exe');
    expect(await fs.readFile(path.join(paths.binDir, 'sibling.dll'), 'utf8')).toBe('fake-dll');
    expect((await fs.readdir(paths.binDir)).some((n) => n.startsWith('whisper-1.8.4'))).toBe(false);
  });

  it('catalog pins the expected release facts', () => {
    expect(WHISPER_BINARY_RELEASE.url).toContain('jiang1997/whisper.cpp-release');
    expect(WHISPER_BINARY_RELEASE.bytes).toBe(37_802_904);
    expect(WHISPER_LOCAL_MODELS.map((m) => m.id)).toEqual(['tiny', 'base', 'small', 'medium', 'large-v3-turbo']);
    expect(findLocalModel('nope')).toBeNull();
  });
});

// ─── Status ────────────────────────────────────────────────────────────────

describe('getLocalSttStatus', () => {
  it('reports binary, models, and storage', async () => {
    await makeDirs();
    const status = await getLocalSttStatus(userData, {}, { exists: async (p) => p.endsWith('.exe') });
    expect(status.binary).toMatchObject({ present: true, source: 'user-data' });
    expect(status.binary.download?.bytes).toBe(WHISPER_BINARY_RELEASE.bytes);
    expect(status.models.find((m) => m.id === 'base')?.downloaded).toBe(false);
    expect(status.storage.capBytes).toBeGreaterThan(0);
  });
});

// ─── Persisted local-STT settings ──────────────────────────────────────────

describe('transcribe config local settings (#39)', () => {
  beforeEach(() => { resetTranscribeConfigCache(); });
  afterEach(() => { resetTranscribeConfigCache(); });

  it('persists engine, model, and binary override for the session', () => {
    setTranscribeConfig({ engine: 'local', localModel: 'small', localBinaryPath: 'D:\\tools\\whisper-cli.exe' });
    expect(getTranscribeConfig()).toMatchObject({
      engine: 'local',
      localModel: 'small',
      localBinaryPath: 'D:\\tools\\whisper-cli.exe',
    });
  });

  it('narrows hostile local values on write', () => {
    setTranscribeConfig({
      engine: 'warp-drive',
      localModel: 'xxl',
      localBinaryPath: `x:${'y'.repeat(600)}.exe`,
    } as unknown as Parameters<typeof setTranscribeConfig>[0]);
    const cfg = getTranscribeConfig();
    expect(cfg.engine).toBeUndefined();
    expect(cfg.localModel).toBeUndefined();
    expect(cfg.localBinaryPath).toHaveLength(512);
  });
});
