/**
 * applyCaptionCues: one fresh video track, frame-snapped cues from seconds,
 * count returned. The planner supplies the cues; this pins materialization.
 */
import { describe, it, expect } from 'vitest';
import { EditorController } from '../editor/controller';
import { applyCaptionCues } from './apply';

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
});
