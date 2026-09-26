/**
 * Agent vs UI caption placement (#91).
 *
 * The executor used to run its own placement loop next to applyCaptionCues, so
 * the two surfaces could place the same cues at different frames. Both now
 * call the shared function, and this pins that the agent path still produces
 * exactly what the UI path produces for the same cues: one new video track,
 * the same clips, the same frames, the same order.
 *
 * Anchoring is asserted here, not frozen: the open question of whether the two
 * transcribe surfaces should offset by the source clip's position is settled
 * (they do), so a clip that is not at frame 0 must place its cues over itself
 * and both surfaces must agree on it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { ToolExecutor } from './executor';
import { EditorController } from '../../shared/editor/controller';
import { applyCaptionCues } from '../../shared/captions/apply';
import { planCaptions, type WordTiming } from '../../shared/captions/planner';

const mocks = vi.hoisted(() => ({ transcribeAudio: vi.fn() }));
vi.mock('./transcribe', () => ({
  transcribeAudio: mocks.transcribeAudio,
}));

let tmpDir = '';
let wavPath = '';

/**
 * Overlapping word timings. planCaptions sorts by startSec but ends a cue at
 * its bucket's LAST word, so with one word per cue these produce cues that
 * overlap in time -- the case that would break if a surface silently shifted
 * or deduped clips.
 */
const WORDS: WordTiming[] = [
  { word: 'Alpha', startSec: 0.0, endSec: 0.8 },
  { word: 'Bravo', startSec: 0.4, endSec: 1.2 },
  { word: 'Charlie', startSec: 0.9, endSec: 1.5 },
  { word: 'Delta', startSec: 1.8, endSec: 2.2 },
];
const PLAN = { maxWordsPerCue: 1 };

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'palmier-caption-parity-'));
  wavPath = path.join(tmpDir, 'speech.wav');
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

/** The two agents an EditorController takes, built identically. */
function agentController(): EditorController {
  const editor = new EditorController();
  editor.addMedia({
    id: 'speech', path: wavPath, filename: 'speech.wav', type: 'audio',
    duration: 6, fileSize: 8192, addedAt: new Date().toISOString(),
  });
  return editor;
}

/** The same, with the asset placed on the timeline at a non-zero frame. */
function agentControllerWithClip(startFrame: number): EditorController {
  const editor = agentController();
  const audioTrackId = editor.getTracks().find((t) => t.type === 'audio')!.id;
  editor.addClip({ assetId: 'speech', trackId: audioTrackId, startFrame, durationFrames: 180 });
  return editor;
}

/** Track shape and clip placement, with the generated ids left out. */
function placed(editor: EditorController) {
  return {
    tracks: editor.getTracks().map((t) => ({ type: t.type, order: t.order, name: t.name })),
    clips: editor.getClips().map((c) => ({
      type: c.type,
      text: c.text,
      startFrame: c.startFrame,
      durationFrames: c.durationFrames,
    })),
  };
}

describe('transcribe_audio places cues identically to the Captions-tab flow', () => {
  it('produces the same track and the same clips at the same frames', async () => {
    // Agent path.
    const agentEditor = agentController();
    const executor = new ToolExecutor(agentEditor, {
      getTranscriptionRuntime: vi.fn().mockResolvedValue({ baseUrl: 'https://x/v1', apiKey: 'k' }),
    });
    mocks.transcribeAudio.mockResolvedValue({
      text: 'Alpha Bravo Charlie Delta',
      words: WORDS,
      segments: [],
      model: 'whisper-1',
    });
    const result = await executor.execute('transcribe_audio', {
      assetId: 'speech', maxWordsPerCue: PLAN.maxWordsPerCue,
    });
    expect(result.success).toBe(true);
    const data = result.data as { cues: number; trackId: string; words: number; previewText: string };

    // UI path: the same planner output handed to the shared placement function.
    const uiEditor = agentController();
    const cues = planCaptions(WORDS, PLAN);
    const applied = applyCaptionCues(uiEditor, cues);

    // A fresh project starts with one video and one audio track; placement
    // appends exactly one more video track on each side.
    expect(agentEditor.getTracks().length).toBe(3);
    expect(uiEditor.getTracks().length).toBe(3);
    expect(placed(agentEditor)).toEqual(placed(uiEditor));

    // Reported counts agree, and the fresh track is the same appended video
    // track on both (the generated id differs by construction).
    expect(data.cues).toBe(cues.length);
    expect(applied.count).toBe(data.cues);
    const agentTrack = agentEditor.getTracks().find((t) => t.id === data.trackId);
    expect(agentTrack).toMatchObject({ type: 'video', name: 'Video 2' });
    expect(uiEditor.getTracks().find((t) => t.id === applied.trackId))
      .toMatchObject({ type: 'video', name: 'Video 2' });
  });

  it('keeps cue order and overlap: one clip per cue, at its own frame', async () => {
    const agentEditor = agentController();
    const executor = new ToolExecutor(agentEditor, {
      getTranscriptionRuntime: vi.fn().mockResolvedValue({ baseUrl: 'https://x/v1', apiKey: 'k' }),
    });
    mocks.transcribeAudio.mockResolvedValue({
      text: 'Alpha Bravo Charlie Delta',
      words: WORDS,
      segments: [],
      model: 'whisper-1',
    });
    const result = await executor.execute('transcribe_audio', {
      assetId: 'speech', maxWordsPerCue: PLAN.maxWordsPerCue,
    });
    const data = result.data as { trackId: string; cues: number; previewText: string };

    const clips = agentEditor.getClips().filter((c) => c.trackId === data.trackId);
    // 30fps: 0.0->0, 0.4->12, 0.9->27, 1.8->54. Cue ends are the last word's
    // endSec, so cues 1/2 and 2/3 overlap: [0,24) [12,36) [27,45) [54,66).
    expect(clips.map((c) => c.text)).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);
    expect(clips.map((c) => c.startFrame)).toEqual([0, 12, 27, 54]);
    expect(clips.map((c) => c.durationFrames)).toEqual([24, 24, 18, 12]);
    expect(data.cues).toBe(4);

    // Overlapping cues coexist: nothing is pushed, dropped, or shortened.
    expect(clips[0]!.startFrame + clips[0]!.durationFrames).toBeGreaterThan(clips[1]!.startFrame);
    expect(clips[1]!.startFrame + clips[1]!.durationFrames).toBeGreaterThan(clips[2]!.startFrame);
    // previewText still comes from the first planned cue.
    expect(data.previewText).toBe('Alpha');
  });

  it('anchors both surfaces to the source clip, not to frame 0', async () => {
    // Agent path, with the transcribed asset sitting at 30s on the timeline.
    const agentEditor = agentControllerWithClip(900);
    const executor = new ToolExecutor(agentEditor, {
      getTranscriptionRuntime: vi.fn().mockResolvedValue({ baseUrl: 'https://x/v1', apiKey: 'k' }),
    });
    mocks.transcribeAudio.mockResolvedValue({
      text: 'Alpha Bravo Charlie Delta',
      words: WORDS,
      segments: [],
      model: 'whisper-1',
    });
    const result = await executor.execute('transcribe_audio', {
      assetId: 'speech', maxWordsPerCue: PLAN.maxWordsPerCue,
    });
    const data = result.data as { trackId: string; cues: number };

    // UI path (Captions tab): the same planner output through the same function.
    const uiEditor = agentControllerWithClip(900);
    const applied = applyCaptionCues(uiEditor, planCaptions(WORDS, PLAN), { assetId: 'speech' });

    // 900 + [0, 12, 27, 54] -- every cue lands over the clip it describes.
    // Before the anchor these were 900 frames (30.000s at 30fps) early.
    expect(agentEditor.getClips().filter((c) => c.trackId === data.trackId).map((c) => c.startFrame))
      .toEqual([900, 912, 927, 954]);
    expect(placed(agentEditor)).toEqual(placed(uiEditor));
    expect(data.cues).toBe(applied.count);
  });
});
