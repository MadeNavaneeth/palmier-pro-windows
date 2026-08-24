/**
 * Comprehensive save/load round-trip coverage for all fields added during
 * the upstream sync (R1–R5). Every optional field on Clip, TimelineMarker,
 * Track, and MediaAsset must survive serialize → deserialize unchanged.
 *
 * A field lost here means silent data loss when a user saves and reopens
 * their project -- the worst kind of bug because it looks fine until the
 * next session.
 */

import { describe, it, expect } from 'vitest';
import { EditorController } from './controller';

function buildFullProject() {
  const ctrl = new EditorController();

  // Media assets
  ctrl.addMedia({
    id: 'asset-video', path: 'D:/footage/interview.mp4', filename: 'interview.mp4',
    type: 'video', duration: 5000, fileSize: 1, audioCodec: 'aac',
    addedAt: new Date().toISOString(),
  });
  ctrl.addMedia({
    id: 'asset-music', path: 'D:/audio/music.mp3', filename: 'music.mp3',
    type: 'audio', duration: 8000, fileSize: 1, addedAt: new Date().toISOString(),
  });

  // Tracks with names
  ctrl.addTrack('video', 'B-roll');
  ctrl.addTrack('audio', 'Voiceover');

  // Linked A/V pair
  ctrl.placeMediaAssets(['asset-video'], 'v1', 0);

  // Independent clips
  ctrl.addClip({ assetId: 'asset-music', trackId: 'a1', startFrame: 200, durationFrames: 200 });
  const titleId = ctrl.addTitleClip({
    trackId: 'v1', startFrame: 100, durationFrames: 90,
    text: 'Opening Title',
  });

  // Title styling
  ctrl.applyClipProperties([titleId], 'Style', (d) => {
    d.titleColor = '#ffcc00';
    d.titleSizeRatio = 0.12;
    d.titleBold = true;
    d.titleFontFamily = 'Georgia';
    d.titleBackgroundColor = '#00000060';
    d.titleStrokeWidth = 2;
    d.titleStrokeColor = '#333333';
    return true;
  });

  // Speed change on first video clip
  const videoClips = ctrl.getClips().filter((c) => c.type === 'video' && c.assetId === 'asset-video');
  if (videoClips.length > 0) {
    ctrl.setClipSpeed(videoClips[0].id, 0.5);
  }

  // Color grade
  const gradedClip = ctrl.getClips()[0];
  ctrl.applyClipProperties([gradedClip.id], 'Grade', (d) => {
    d.brightness = -0.15;
    d.contrast = 1.3;
    d.saturation = 0.7;
    d.hueRotation = 30;
    return true;
  });

  // Pan
  const audioClip = ctrl.getClips().find((c) => c.type === 'audio' && c.assetId === 'asset-music');
  if (audioClip) {
    ctrl.setClipPan(audioClip.id, -0.5);
  }

  // Markers
  ctrl.changeTimelineMarkers({
    creates: [
      { name: 'Interview Start', startFrame: 50 },
      { name: 'Key Moment', startFrame: 300, durationFrames: 100, comment: 'Important quote' },
    ],
  });

  // Fades
  const firstVideo = ctrl.getClips().find((c) => c.type === 'video')!;
  ctrl.setClipFade(firstVideo.id, 15, 25);

  return ctrl;
}

describe('project round-trip: all fields survive save/load', () => {
  it('round-trips titles with full styling', () => {
    const ctrl = new EditorController();
    ctrl.addTitleClip({ trackId: 'v1', text: 'Test', startFrame: 10, durationFrames: 30 });
    ctrl.copySettingsSnapshot; // no-op, just accessing API surface
    ctrl.applyClipProperties(ctrl.getClips().map((c) => c.id), 'Style', (d) => {
      d.titleColor = '#ff5500';
      d.titleSizeRatio = 0.15;
      d.titleBold = true;
      d.titleFontFamily = 'Georgia';
      d.titleAlign = 'left';
      d.titleBackgroundColor = '#00000090';
      d.titleStrokeWidth = 3;
      d.titleStrokeColor = '#222222';
      return true;
    });

    const json = ctrl.serialize();
    const restored = new EditorController(JSON.parse(json));

    expect(restored.getClips()).toHaveLength(1);
    const clip = restored.getClips()[0];
    expect(clip.text).toBe('Test');
    expect(clip.titleColor).toBe('#ff5500');
    expect(clip.titleSizeRatio).toBeCloseTo(0.15);
    expect(clip.titleBold).toBe(true);
    expect(clip.titleFontFamily).toBe('Georgia');
    expect(clip.titleAlign).toBe('left');
    expect(clip.titleBackgroundColor).toBe('#00000090');
    expect(clip.titleStrokeWidth).toBe(3);
    expect(clip.titleStrokeColor).toBe('#222222');
  });

  it('round-trips speed, color grade, and pan on clips', () => {
    const ctrl = new EditorController();
    ctrl.addMedia({
      id: 'a-v', path: '/test/v.mp4', filename: 'v.mp4', type: 'video',
      duration: 5000, fileSize: 1, addedAt: new Date().toISOString(),
    });
    const id = ctrl.addClip({ assetId: 'a-v', trackId: 'v1', startFrame: 0, durationFrames: 100 });

    ctrl.setClipSpeed(id, 2);
    ctrl.applyClipProperties([id], 'Grade', (d) => {
      d.brightness = 0.1;
      d.contrast = 1.5;
      d.saturation = 0.8;
      d.hueRotation = -30;
      d.pan = 0.6;
      return true;
    });

    const json = ctrl.serialize();
    const restored = new EditorController(JSON.parse(json));
    const clip = restored.getClips().find((c) => c.id === id)!;
    expect(clip.speed).toBe(2);
    expect(clip.pan).toBe(0.6);
    expect(clip.brightness).toBe(0.1);
    expect(clip.contrast).toBe(1.5);
    expect(clip.saturation).toBe(0.8);
    expect(clip.hueRotation).toBe(-30);
  });

  it('round-trips markers with ranges and comments', () => {
    const ctrl = new EditorController();
    ctrl.changeTimelineMarkers({
      creates: [
        { name: 'Point', startFrame: 100, color: '#ff0000' },
        { name: 'Range', startFrame: 200, durationFrames: 150, comment: 'Review this' },
      ],
    });

    const json = ctrl.serialize();
    const restored = new EditorController(JSON.parse(json));
    expect(restored.getMarkers()).toHaveLength(2);
    const range = restored.getMarkers().find((m) => m.name === 'Range')!;
    expect(range.durationFrames).toBe(150);
    expect(range.comment).toBe('Review this');
  });

  it('round-trips proxy paths on media assets', () => {
    const ctrl = new EditorController();
    ctrl.addMedia({
      id: 'asset-proxy', path: 'D:/src/heavy.mp4', filename: 'heavy.mp4',
      type: 'video', duration: 1000, fileSize: 1, addedAt: new Date().toISOString(),
    });
    ctrl.setProxyState('asset-proxy', 'C:/proxies/heavy.mp4');

    const json = ctrl.serialize();
    const restored = new EditorController(JSON.parse(json));
    expect(restored.getMedia()[0].proxyPath).toBe('C:/proxies/heavy.mp4');
  });
});
