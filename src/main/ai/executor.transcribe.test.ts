/**
 * transcribe_audio (#39 groundwork / #91): the executor bridges the pure
 * transcription transport and the caption planner. The transport is mocked
 * (network); what is under test is resolution, refusal, and caption
 * materialization.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { ToolExecutor } from './executor';
import { EditorController } from '../../shared/editor/controller';

const mocks = vi.hoisted(() => ({ transcribeAudio: vi.fn() }));
vi.mock('./transcribe', () => ({
  transcribeAudio: mocks.transcribeAudio,
}));

import { transcribeAudio } from './transcribe';

let tmpDir = '';
let wavPath = '';

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'palmier-transcribe-'));
  wavPath = path.join(tmpDir, 'speech.wav');
  // Minimal WAV header; the transport is mocked so bytes are irrelevant,
  // but a real file keeps any accidental read honest.
  const buf = Buffer.alloc(8192);
  buf.write('RIFF', 0);
  buf.write('WAVE', 8);
  await fs.writeFile(wavPath, buf);

  mocks.transcribeAudio.mockReset();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function harness(runtime?: { baseUrl: string; apiKey: string } | null) {
  const editor = new EditorController();
  editor.addMedia({
    id: 'speech', path: wavPath, filename: 'speech.wav', type: 'audio',
    duration: 6, fileSize: 8192, addedAt: new Date().toISOString(),
  });
  const getTranscriptionRuntime = vi.fn().mockResolvedValue(runtime ?? null);
  const executor = new ToolExecutor(editor, { getTranscriptionRuntime });
  return { editor, executor, getTranscriptionRuntime };
}

const WORDS = [
  { word: 'Welcome', startSec: 0.0, endSec: 0.5 },
  { word: 'back.', startSec: 0.6, endSec: 1.0 },
];

describe('transcribe_audio', () => {
  it('plans captions onto a fresh track with word-snapped timing', async () => {
    const { editor, executor, getTranscriptionRuntime } = harness({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
    });
    mocks.transcribeAudio.mockResolvedValue({
      text: 'Welcome back.',
      words: WORDS,
      segments: [],
      model: 'whisper-1',
    });

    const result = await executor.execute('transcribe_audio', {
      assetId: 'speech', language: 'en',
    });

    expect(result.success).toBe(true);
    const data = result.data as { cues: number; trackId: string; words: number };
    expect(data.cues).toBe(1);
    expect(data.words).toBe(2);

    const trackClips = editor.getClips().filter((c) => c.trackId === data.trackId);
    expect(trackClips).toHaveLength(1);
    expect(trackClips[0].text).toBe('Welcome back.');
    expect(trackClips[0].startFrame).toBe(0); // snapped to word start
    expect(getTranscriptionRuntime).toHaveBeenCalled();

    // Transport receives the runtime + resolved options.
    expect(mocks.transcribeAudio).toHaveBeenCalledWith(
      { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' },
      wavPath,
      { language: 'en', model: undefined },
    );
    void transcribeAudio;
  });

  it('refuses cleanly when no transcription runtime is configured', async () => {
    const { editor, executor } = harness(null);

    const result = await executor.execute('transcribe_audio', { assetId: 'speech' });

    expect(result.success).toBe(false);
    expect((result as { error?: string }).error).toMatch(/no OpenAI-compatible/i);
    expect(editor.getTracks().filter((t) => t.type === 'video')).toHaveLength(1); // default only
  });

  it('surfaces transport failures without placing clips', async () => {
    const { editor, executor } = harness({ baseUrl: 'https://x/v1', apiKey: 'k' });
    mocks.transcribeAudio.mockRejectedValue(new Error('401 invalid key'));

    const result = await executor.execute('transcribe_audio', { assetId: 'speech' });

    expect(result.success).toBe(false);
    expect((result as { error?: string }).error).toContain('401');
    expect(editor.getClips()).toHaveLength(0);
  });
});
