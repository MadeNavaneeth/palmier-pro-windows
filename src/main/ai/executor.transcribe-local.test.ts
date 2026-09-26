/**
 * transcribe_audio — local engine half (#39): the executor routes explicit
 * and auto-resolved local jobs through the injected stub runtime, refuses
 * degraded local states without spending cloud credit, and lays stub words
 * onto cues through the same planner as cloud results.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { ToolExecutor } from './executor';
import { EditorController } from '../../shared/editor/controller';
import { resolveLocalSttPaths } from '../media/whisper-local';
import type { TranscriptionResult } from './transcribe';

let tmpDir = '';
let wavPath = '';
let sttDir = '';

const WORDS = [
  { word: 'Hallo', startSec: 0.0, endSec: 0.4 },
  { word: 'Welt.', startSec: 0.5, endSec: 0.9 },
];

const stubResult: TranscriptionResult = {
  text: 'Hallo Welt.',
  words: WORDS,
  segments: [{ startSec: 0, endSec: 0.9, text: 'Hallo Welt.' }],
  model: 'local:base',
};

async function setup(): Promise<void> {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'palmier-exec-local-'));
  wavPath = path.join(tmpDir, 'speech.wav');
  await fs.writeFile(wavPath, Buffer.alloc(64));
  // A "fully available" local engine: binary + model files on disk.
  sttDir = path.join(tmpDir, 'userData');
  const paths = resolveLocalSttPaths(sttDir);
  await fs.mkdir(paths.binDir, { recursive: true });
  await fs.mkdir(paths.modelsDir, { recursive: true });
  await fs.writeFile(paths.binaryPath, 'fake-exe');
  await fs.writeFile(paths.modelPath('base')!, 'fake-model');
}

afterEach(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  tmpDir = '';
  vi.restoreAllMocks();
});

function harness(opts: {
  sttDir?: string | null;
  runLocal?: (input: { audioPath: string; language?: string; modelId: string }) => Promise<TranscriptionResult>;
  cloud?: { baseUrl: string; apiKey: string } | null;
} = {}) {
  const editor = new EditorController();
  editor.addMedia({
    id: 'speech', path: wavPath, filename: 'speech.wav', type: 'audio',
    duration: 6, fileSize: 64, addedAt: new Date().toISOString(),
  });
  const runLocalTranscription = vi.fn(opts.runLocal ?? (async () => stubResult));
  const getTranscriptionRuntime = vi.fn().mockResolvedValue(opts.cloud ?? null);
  const executor = new ToolExecutor(editor, {
    getTranscriptionRuntime,
    getLocalSttDir: () => opts.sttDir === undefined ? sttDir : opts.sttDir,
    runLocalTranscription,
  });
  return { editor, executor, runLocalTranscription, getTranscriptionRuntime };
}

describe('transcribe_audio local engine (#39)', () => {
  beforeEach(setup);

  it('runs an explicit local job through the stub and lays cues identically', async () => {
    const { editor, executor, runLocalTranscription } = harness();
    const result = await executor.execute('transcribe_audio', { assetId: 'speech', language: 'de', engine: 'local' });

    expect(result.success).toBe(true);
    expect(runLocalTranscription).toHaveBeenCalledWith({ audioPath: wavPath, language: 'de', modelId: 'base' });
    const data = result.data as { cues: number; trackId: string; words: number; model: string };
    expect(data).toMatchObject({ cues: 1, words: 2, model: 'local:base' });
    const placed = editor.getClips().filter((c) => c.trackId === data.trackId);
    expect(placed).toHaveLength(1);
    expect(placed[0]!.text).toBe('Hallo Welt.');
  });

  it('auto prefers local when the binary and model are present', async () => {
    const { executor, runLocalTranscription } = harness({
      cloud: { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' },
    });
    const result = await executor.execute('transcribe_audio', { assetId: 'speech' });

    expect(result.success).toBe(true);
    expect(runLocalTranscription).toHaveBeenCalled();
    expect((result.data as { model: string }).model).toBe('local:base');
  });

  it('explicit local refuses a degraded engine without touching cloud', async () => {
    const runLocalTranscription = vi.fn(async () => {
      throw new Error('Local model "base" (≈142 MB) is not downloaded. Download it under Captions → Engine → Local before transcribing.');
    });
    const { editor, executor, getTranscriptionRuntime } = harness({ runLocal: runLocalTranscription });
    const result = await executor.execute('transcribe_audio', { assetId: 'speech', engine: 'local' });

    expect(result.success).toBe(false);
    expect((result as { error?: string }).error).toMatch(/not downloaded/);
    expect(getTranscriptionRuntime).not.toHaveBeenCalled();
    expect(editor.getClips()).toHaveLength(0);
  });

  it('explicit local with no app directories refuses instead of falling back', async () => {
    const { editor, executor } = harness({
      sttDir: null,
      cloud: { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' },
    });
    const result = await executor.execute('transcribe_audio', { assetId: 'speech', engine: 'local' });

    expect(result.success).toBe(false);
    expect((result as { error?: string }).error).toMatch(/binary is not installed/);
    expect(editor.getClips()).toHaveLength(0);
  });

  it('refuses an unsupported language precisely without running anything', async () => {
    const { executor, runLocalTranscription } = harness();
    const result = await executor.execute('transcribe_audio', { assetId: 'speech', language: 'xx', engine: 'local' });

    expect(result.success).toBe(false);
    expect((result as { error?: string }).error).toMatch(/"xx" is not a whisper language code/);
    expect(runLocalTranscription).not.toHaveBeenCalled();
  });
});
