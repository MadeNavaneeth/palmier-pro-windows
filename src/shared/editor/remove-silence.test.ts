import { describe, it, expect } from 'vitest';
import { EditorController } from './controller';
import { timelineFrameForSourceSeconds } from '../media/source-time';

/** 30fps project: 1 second = 30 frames. */
function setup() {
  const ctrl = new EditorController();
  ctrl.addMedia({
    id: 'a1', path: '/v.mp4', filename: 'v.mp4', type: 'video',
    duration: 300, fileSize: 1, addedAt: new Date().toISOString(),
  });
  return ctrl;
}

function linkedSetup() {
  const ctrl = new EditorController();
  ctrl.addMedia({
    id: 'av', path: '/linked.mp4', filename: 'linked.mp4', type: 'video',
    audioCodec: 'aac', duration: 360, fileSize: 1, addedAt: new Date().toISOString(),
  });
  const videoId = ctrl.addClip({
    assetId: 'av', trackId: 'v1', startFrame: 0, durationFrames: 300,
  });
  ctrl.addClip({ assetId: 'av', trackId: 'v1', startFrame: 300, durationFrames: 60 });
  return { ctrl, videoId };
}

function spans(ctrl: EditorController, trackId: string) {
  return ctrl.getClips()
    .filter((clip) => clip.trackId === trackId)
    .sort((left, right) => left.startFrame - right.startFrame)
    .map((clip) => [clip.startFrame, clip.startFrame + clip.durationFrames]);
}

describe('EditorController.removeSilence', () => {
  it('splits a clip into kept segments and reports the count', () => {
    const ctrl = setup();
    // Clip on timeline [0,300), source [0,300).
    const clipId = ctrl.addClip({ assetId: 'a1', trackId: 'v1', startFrame: 0, durationFrames: 300 });

    // Silence from 3s–4s (source seconds) => frames 90–120 at 30fps.
    const removed = ctrl.removeSilence(clipId, [{ startSec: 3, endSec: 4 }]);
    expect(removed).toBe(1);

    const clips = ctrl.getClips().sort((a, b) => a.startFrame - b.startFrame);
    expect(clips).toHaveLength(2);
    // First kept segment: source [0,90), timeline [0,90)
    expect(clips[0].inPoint).toBe(0);
    expect(clips[0].outPoint).toBe(90);
    expect(clips[0].startFrame).toBe(0);
    // Second kept segment placed contiguously after the first (gap closed).
    expect(clips[1].inPoint).toBe(120);
    expect(clips[1].outPoint).toBe(300);
    expect(clips[1].startFrame).toBe(90);
  });

  it('ripples later clips on the same track left by the removed amount', () => {
    const ctrl = setup();
    const clipId = ctrl.addClip({ assetId: 'a1', trackId: 'v1', startFrame: 0, durationFrames: 300 });
    // A second clip after the first at frame 300.
    const laterId = ctrl.addClip({ assetId: 'a1', trackId: 'v1', startFrame: 300, durationFrames: 60 });

    ctrl.removeSilence(clipId, [{ startSec: 3, endSec: 4 }]); // removes 30 frames

    const later = ctrl.getClips().find((c) => c.id === laterId)!;
    expect(later.startFrame).toBe(270); // 300 - 30 removed
  });

  it('is a single undoable operation', () => {
    const ctrl = setup();
    const clipId = ctrl.addClip({ assetId: 'a1', trackId: 'v1', startFrame: 0, durationFrames: 300 });
    expect(ctrl.getClips()).toHaveLength(1);

    ctrl.removeSilence(clipId, [{ startSec: 3, endSec: 4 }]);
    expect(ctrl.getClips()).toHaveLength(2);

    ctrl.undo();
    const clips = ctrl.getClips();
    expect(clips).toHaveLength(1);
    expect(clips[0].id).toBe(clipId);
    expect(clips[0].durationFrames).toBe(300);
  });

  it('does nothing when no silence is supplied', () => {
    const ctrl = setup();
    const clipId = ctrl.addClip({ assetId: 'a1', trackId: 'v1', startFrame: 0, durationFrames: 300 });
    expect(ctrl.removeSilence(clipId, [])).toBe(0);
    expect(ctrl.getClips()).toHaveLength(1);
  });

  it('ripples linked video and embedded audio together in one undo step', () => {
    const { ctrl, videoId } = linkedSetup();
    const before = ctrl.getClips().map((clip) => ({ ...clip }));

    expect(ctrl.removeSilence(videoId, [{ startSec: 3, endSec: 4 }])).toBe(1);

    expect(spans(ctrl, 'v1')).toEqual([[0, 90], [90, 270], [270, 330]]);
    expect(spans(ctrl, 'a1')).toEqual([[0, 90], [90, 270], [270, 330]]);
    expect(ctrl.undo()).toBe(true);
    expect(ctrl.getClips()).toEqual(before);
  });

  it('refuses a linked ripple when either partner track is locked', () => {
    const { ctrl, videoId } = linkedSetup();
    ctrl.setTrackLocked('a1', true);
    const before = ctrl.getClips().map((clip) => ({ ...clip }));
    const undoBefore = ctrl.canUndo();

    expect(ctrl.removeSilence(videoId, [{ startSec: 3, endSec: 4 }])).toBe(0);
    expect(ctrl.getClips()).toEqual(before);
    expect(ctrl.canUndo()).toBe(undoBefore);
  });

  it('remaps markers across the linked ripple', () => {
    const { ctrl, videoId } = linkedSetup();
    ctrl.changeTimelineMarkers({ creates: [{ name: 'Later pair', startFrame: 330 }] });

    ctrl.removeSilence(videoId, [{ startSec: 3, endSec: 4 }]);

    expect(ctrl.getMarkers()).toHaveLength(1);
    expect(ctrl.getMarkers()[0]).toMatchObject({ name: 'Later pair', startFrame: 300 });
    expect(spans(ctrl, 'v1')).toEqual([[0, 90], [90, 270], [270, 330]]);
    expect(spans(ctrl, 'a1')).toEqual([[0, 90], [90, 270], [270, 330]]);
  });
});

/**
 * A linked A/V pair sped up to 2x. `setClipSpeed` refuses audio as a direct
 * target but writes `speed` onto the linked partner, so the audio side carries
 * a speed the silence mapper has to honour.
 */
function spedUpPair() {
  const ctrl = new EditorController();
  ctrl.addMedia({
    id: 'av', path: '/av.mp4', filename: 'av.mp4', type: 'video',
    audioCodec: 'aac', duration: 1800, fileSize: 1, addedAt: new Date().toISOString(),
  });
  const videoId = ctrl.addClip({
    assetId: 'av', trackId: 'v1', startFrame: 0, durationFrames: 300,
  });
  expect(ctrl.setClipSpeed(videoId, 2)).toBe(true);

  const audio = ctrl.getClips().find((clip) => clip.type === 'audio')!;
  // 300 timeline frames at 2x consume 600 source frames (20s).
  expect(audio).toMatchObject({ trackId: 'a1', speed: 2, inPoint: 0, outPoint: 600 });
  return { ctrl, audioId: audio.id };
}

describe('EditorController.removeSilence on a sped-up clip', () => {
  it('cuts the detected silence instead of speech twice past it', () => {
    const { ctrl, audioId } = spedUpPair();

    // Source 2.0-2.5s. The shared source-time model puts that at timeline
    // frames 30..38; the mapping without the speed term cut 60..75, which is
    // source 4.0-5.0s -- half a second of speech deleted, silence kept.
    const removed = ctrl.removeSilence(audioId, [{ startSec: 2, endSec: 2.5 }]);

    expect(removed).toBe(1);
    expect(spans(ctrl, 'a1')).toEqual([[0, 30], [30, 292]]);
    expect(spans(ctrl, 'v1')).toEqual([[0, 30], [30, 292]]);
  });

  it('reports a count when the legacy mapping found nothing to cut', () => {
    const { ctrl, audioId } = spedUpPair();

    // Source 12.0-13.5s is timeline 180..203 at 2x. Without the speed term
    // both ends mapped past the clip end, the range was dropped as empty and
    // the caller reported "no silence" for a range the detector had returned.
    const removed = ctrl.removeSilence(audioId, [{ startSec: 12, endSec: 13.5 }]);

    expect(removed).toBe(1);
    expect(spans(ctrl, 'a1')).toEqual([[0, 180], [180, 277]]);
  });

  it('cuts where the shared model maps the source seconds', () => {
    const { ctrl, audioId } = spedUpPair();
    const audio = ctrl.getClips().find((clip) => clip.id === audioId)!;

    // The contract is source seconds in, the frames sourceSecondsForTimelineFrame
    // reads back -- not a speed-1 frame count.
    expect(timelineFrameForSourceSeconds(audio, 2, 30)).toBe(30);
    expect(timelineFrameForSourceSeconds(audio, 2.5, 30)).toBe(38);

    ctrl.removeSilence(audioId, [{ startSec: 2, endSec: 2.5 }]);

    // The gap left behind is the mapped range, so the kept fragments start
    // exactly where the silence was. (Their trim windows are not asserted:
    // rippleDeleteRanges rescales neither inPoint nor outPoint for a sped-up
    // clip, which is a separate defect from this mapping.)
    const kept = ctrl.getClips()
      .filter((clip) => clip.type === 'audio')
      .sort((left, right) => left.startFrame - right.startFrame);
    expect(kept.map((clip) => clip.durationFrames)).toEqual([30, 262]);
  });
});
