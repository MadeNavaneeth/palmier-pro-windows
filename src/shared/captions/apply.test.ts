/**
 * applyCaptionCues: one fresh video track, frame-snapped cues from seconds,
 * count returned, and the placement contract every caption surface shares --
 * anchor on the source asset, clamp into representable frames, sanitize the
 * text, ONE undo step. The planner supplies the cues; this pins
 * materialization, and the SRT/VTT importer places through the same math.
 */
import { describe, it, expect } from 'vitest';
import { EditorController } from '../editor/controller';
import { MAX_FRAME } from '../utils/safe-number';
import { TITLE_TEXT_MAX_LENGTH, sanitizeTitleText } from '../editor/title';
import { applyCaptionCues } from './apply';

/** A 30-minute podcast asset on track A1, the reported failure case. */
function podcastAt(startFrame: number): { editor: EditorController; audioTrackId: string } {
  const editor = new EditorController();
  editor.addMedia({
    id: 'podcast', path: 'C:/media/ep1.wav', filename: 'ep1.wav', type: 'audio',
    duration: 1800, fileSize: 1024, addedAt: new Date().toISOString(),
  });
  const audioTrackId = editor.getTracks().find((t) => t.type === 'audio')!.id;
  editor.addClip({ assetId: 'podcast', trackId: audioTrackId, startFrame, durationFrames: 30 * 1800 });
  return { editor, audioTrackId };
}

function captionClips(editor: EditorController, trackId: string) {
  return editor.getClips().filter((c) => c.trackId === trackId);
}

describe('applyCaptionCues (#91/#39 wiring)', () => {
  it('places each cue on one new video track at fps-scaled frames', () => {
    const editor = new EditorController();
    const before = editor.getTracks().filter((t) => t.type === 'video').length;

    const result = applyCaptionCues(editor, [
      { startSec: 0, endSec: 1, text: 'Hello world' },
      { startSec: 5.5, endSec: 6.25, text: 'Second cue' },
    ]);

    expect(result.count).toBe(2);
    const videoTracks = editor.getTracks().filter((t) => t.type === 'video');
    expect(videoTracks.length).toBe(before + 1);

    const trackId = result.trackId;
    const clips = editor.getClips().filter((c) => c.trackId === trackId);
    expect(clips).toHaveLength(2);
    // 30fps project: 0s→0, 1s→30; 5.5s→165, 6.25s→187 (duration 22).
    expect(clips[0]).toMatchObject({ startFrame: 0, durationFrames: 30, type: 'title' });
    expect(clips[1]).toMatchObject({ startFrame: 165, durationFrames: 23 });
  });

  it('clamps negative starts to zero', () => {
    const editor = new EditorController();
    const result = applyCaptionCues(editor, [
      { startSec: -0.4, endSec: 0.8, text: 'early' },
    ]);
    expect(result.count).toBe(1);
    const clip = editor.getClips().at(-1)!;
    expect(clip.startFrame).toBe(0);
  });

  // ─── Anchoring: the settled question ───────────────────────────────────
  //
  // A cue's seconds are relative to the source it came from. Placing them at
  // `startSec * fps` silently assumed the source begins at frame 0, so every
  // cue of a clip placed later landed exactly as many frames early as the
  // clip sits late -- 900 frames / 30.000s for a podcast starting at 30s.

  it('anchors cues to the source asset, not to frame 0', () => {
    const { editor } = podcastAt(900);

    const result = applyCaptionCues(editor, [
      { startSec: 0, endSec: 2, text: 'Welcome to episode one.' },
      { startSec: 600, endSec: 602, text: 'Ten minutes in.' },
    ], { assetId: 'podcast' });

    // 30fps: 900 + [0s,2s) -> [900, 960); 900 + [600s,602s) -> [18900, 18960).
    const clips = captionClips(editor, result.trackId);
    expect(clips.map((c) => c.startFrame)).toEqual([900, 18900]);
    expect(clips.map((c) => c.durationFrames)).toEqual([60, 60]);
  });

  it('places the same cues identically through the SRT importer', () => {
    const { editor } = podcastAt(900);
    const videoTrackId = editor.getTracks().find((t) => t.type === 'video')!.id;
    const srt = [
      '1', '00:00:00,000 --> 00:00:02,000', 'Welcome to episode one.', '',
      '2', '00:10:00,000 --> 00:10:02,000', 'Ten minutes in.', '',
    ].join('\n');

    const transcriber = applyCaptionCues(editor, [
      { startSec: 0, endSec: 2, text: 'Welcome to episode one.' },
      { startSec: 600, endSec: 602, text: 'Ten minutes in.' },
    ], { assetId: 'podcast' });

    const imported = editor.importSrt(videoTrackId, srt, 900);
    const frames = (ids: string[]) => ids
      .map((id) => editor.getClips().find((c) => c.id === id)!)
      .map((c) => [c.startFrame, c.durationFrames]);
    expect(frames(captionClips(editor, transcriber.trackId).map((c) => c.id)))
      .toEqual(frames(imported));
  });

  it('keeps a source at frame 0 (and the playhead fallback) exactly as before', () => {
    const { editor } = podcastAt(0);
    const result = applyCaptionCues(editor, [
      { startSec: 0, endSec: 2, text: 'At the head.' },
      { startSec: 600, endSec: 602, text: 'Ten minutes in.' },
    ], { assetId: 'podcast' });

    expect(captionClips(editor, result.trackId).map((c) => c.startFrame)).toEqual([0, 18000]);

    // No asset on the timeline: the playhead is the base, as the importer's.
    const off = new EditorController();
    off.setPlayhead(450);
    const anchored = applyCaptionCues(off, [{ startSec: 1, endSec: 2, text: 'From the playhead.' }]);
    expect(captionClips(off, anchored.trackId)[0]!.startFrame).toBe(480);
  });

  it('anchors to the earliest clip when the source is used more than once', () => {
    const { editor, audioTrackId } = podcastAt(900);
    editor.addClip({ assetId: 'podcast', trackId: audioTrackId, startFrame: 5400, durationFrames: 300 });

    const result = applyCaptionCues(editor, [{ startSec: 1, endSec: 2, text: 'Reused.' }], { assetId: 'podcast' });
    expect(captionClips(editor, result.trackId)[0]!.startFrame).toBe(930);
  });

  // ─── Clamping: a cue may never write an unrepresentable frame ───────────

  it('keeps placement inside the representable frame range at the timeline end', () => {
    const editor = new EditorController();
    editor.setPlayhead(MAX_FRAME - 2);

    const result = applyCaptionCues(editor, [
      { startSec: 0, endSec: 2, text: 'last frames' },
      { startSec: 10, endSec: 12, text: 'past the end' },
    ]);

    for (const clip of captionClips(editor, result.trackId)) {
      expect(clip.startFrame).toBeGreaterThanOrEqual(0);
      expect(clip.startFrame).toBeLessThanOrEqual(MAX_FRAME);
      expect(clip.durationFrames).toBeGreaterThanOrEqual(1);
      expect(clip.startFrame + clip.durationFrames).toBeLessThanOrEqual(MAX_FRAME);
    }
  });

  it('clamps absurd provider timings instead of refusing the call', () => {
    const editor = new EditorController();
    const result = applyCaptionCues(editor, [
      { startSec: 1e12, endSec: 1e12 + 5, text: 'absurd start' },
      { startSec: Number.NaN, endSec: 3, text: 'absurd timing' },
    ]);

    expect(result.count).toBe(2);
    for (const clip of captionClips(editor, result.trackId)) {
      expect(clip.startFrame + clip.durationFrames).toBeLessThanOrEqual(MAX_FRAME);
      expect(Number.isFinite(clip.startFrame)).toBe(true);
    }
  });

  // ─── Sanitizing: the same rules the importer applies ───────────────────

  it('sanitizes cue text and does not count a cue it refused', () => {
    const editor = new EditorController();
    const raw = 'clean\u0000\u0007 text\rhere';
    const result = applyCaptionCues(editor, [
      { startSec: 0, endSec: 1, text: raw },
      { startSec: 1, endSec: 2, text: '   ' },
      { startSec: 2, endSec: 3, text: 'x'.repeat(TITLE_TEXT_MAX_LENGTH + 1) },
      { startSec: 3, endSec: 4, text: 'kept' },
    ]);

    const clips = captionClips(editor, result.trackId);
    // Identical to what the SRT importer writes for the same raw string.
    expect(clips.map((c) => c.text)).toEqual([sanitizeTitleText(raw), 'kept']);
    expect(clips[0]!.text).toBe('clean texthere'); // NUL/BEL/CR stripped
    // The reported count is what landed, so a UI or agent "placed N" claim
    // can never overstate the timeline.
    expect(result.count).toBe(clips.length);
  });

  // ─── Undo granularity ──────────────────────────────────────────────────

  it('is one undoable step: the track and every cue come back together', () => {
    const editor = new EditorController();
    const tracksBefore = editor.getTracks().length;
    const result = applyCaptionCues(editor, [
      { startSec: 0, endSec: 1, text: 'a' },
      { startSec: 1, endSec: 2, text: 'b' },
      { startSec: 2, endSec: 3, text: 'c' },
    ]);

    expect(editor.getClips().filter((c) => c.trackId === result.trackId)).toHaveLength(3);
    expect(editor.undo()).toBe(true);
    expect(editor.getClips()).toHaveLength(0);
    expect(editor.getTracks()).toHaveLength(tracksBefore);
    expect(editor.canUndo()).toBe(false);

    expect(editor.redo()).toBe(true);
    expect(editor.getClips().filter((c) => c.trackId === result.trackId)).toHaveLength(3);
  });
});
