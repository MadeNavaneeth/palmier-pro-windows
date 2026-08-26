/**
 * Round-trip coverage for the FCPXML interchange (#154): export a fixture
 * project, parse it back, and assert the supported subset survives â€” plus
 * foreign-format tolerance (rational times, gaps) and unsupported notes.
 */
import { describe, it, expect } from 'vitest';
import type { Project } from '../types/project';
import { exportFcpxml } from './exporter';
import { parseFcpxml, parseFcpxmlTime } from './importer';

function baseProject(): Project {
  return {
    version: 2,
    name: 'Round Trip',
    settings: { width: 1920, height: 1080, fps: 30, sampleRate: 48000, backgroundColor: '#000000' },
    media: [],
    timeline: {
      tracks: [
        { id: 'v1', name: 'Video 1', type: 'video', locked: false, visible: true, syncLocked: true, order: 0 },
        { id: 'v2', name: 'Video 2', type: 'video', locked: false, visible: true, syncLocked: true, order: 1 },
        { id: 'a1', name: 'Audio 1', type: 'audio', locked: false, visible: true, syncLocked: true, order: 2 },
      ],
      clips: [],
      playheadFrame: 0,
    },
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-26T00:00:00.000Z',
  } as unknown as Project;
}

function fixtureProject(): Project {
  const p = baseProject();
  p.media.push(
    { id: 'a', path: 'C:/media/footage.mp4', filename: 'footage.mp4', type: 'video', duration: 60, fileSize: 1, addedAt: '', width: 1920, height: 1080, audioCodec: 'aac' },
    { id: 'm', path: 'C:/media/music.wav', filename: 'music.wav', type: 'audio', duration: 90, fileSize: 1, addedAt: '' },
  );
  const base = {
    assetId: 'a', label: 'Shot A', trackId: 'v1', type: 'video' as const,
    startFrame: 45, durationFrames: 90, inPoint: 15, outPoint: 105,
    x: 0, y: 0, width: 1920, height: 1080, rotation: 0, scaleX: 1, scaleY: 1,
    opacity: 1, anchorX: 0, anchorY: 0, volume: 1, muted: false,
  };
  p.timeline.clips.push(
    { ...base, id: 'c1' },
    { ...base, id: 'c2', trackId: 'v2', startFrame: 60, label: 'Overlay B' },
    { ...base, id: 'c3', assetId: 'm', type: 'audio', trackId: 'a1', startFrame: 0, durationFrames: 120, inPoint: 0, outPoint: 120, label: 'Music' },
    {
      ...base, id: 'c4', assetId: '__title__', type: 'title', text: 'Opening <Title>',
      titleColor: '#ffcc00', titleSizeRatio: 0.08, titleFontFamily: 'Georgia',
      titleAlign: 'left', startFrame: 0, durationFrames: 45, inPoint: 0, outPoint: 45,
    },
  );
  return p;
}

describe('parseFcpxmlTime', () => {
  it('reads decimal, rational, and bare seconds', () => {
    expect(parseFcpxmlTime('1.500000s')).toBe(1.5);
    expect(parseFcpxmlTime('45/30s')).toBe(1.5);
    expect(parseFcpxmlTime('2')).toBe(2);
    expect(parseFcpxmlTime('nonsense')).toBeNull();
  });
});

describe('#154 round trip', () => {
  const xml = exportFcpxml(fixtureProject());
  const parsed = parseFcpxml(xml);

  it('recovers canvas and event name', () => {
    expect(parsed.name).toBe('Round Trip');
    expect(parsed.fps).toBe(30);
    expect(parsed.width).toBe(1920);
    expect(parsed.height).toBe(1080);
  });

  it('recovers both assets with paths and stream flags', () => {
    expect(parsed.assets).toHaveLength(2);
    const footage = parsed.assets.find((a) => a.path === 'C:/media/footage.mp4');
    const music = parsed.assets.find((a) => a.path === 'C:/media/music.wav');
    expect(footage).toMatchObject({ hasVideo: true, hasAudio: true });
    expect(music).toMatchObject({ hasVideo: false, hasAudio: true });
  });

  it('maps frames exactly through decimal seconds at 30fps', () => {
    const video = parsed.clips.filter((c): c is Extract<typeof c, { kind: 'video' }> => c.kind === 'video');
    const spine = video.find((c) => c.lane === 0)!;
    const upper = video.find((c) => c.lane === 1)!;
    expect(spine).toMatchObject({ startFrame: 45, durationFrames: 90, sourceInFrame: 15, assetPath: 'C:/media/footage.mp4', label: 'Shot A' });
    expect(upper).toMatchObject({ startFrame: 60, label: 'Overlay B' });
  });

  it('maps audio to negative lanes', () => {
    const audio = parsed.clips.filter((c) => c.kind === 'audio');
    expect(audio).toHaveLength(1);
    expect(audio[0]).toMatchObject({ lane: -1, startFrame: 0, durationFrames: 120, assetPath: 'C:/media/music.wav' });
  });

  it('restores title text unescaped with its style', () => {
    const titles = parsed.clips.filter((c) => c.kind === 'title');
    expect(titles).toHaveLength(1);
    expect(titles[0]).toMatchObject({
      text: 'Opening <Title>',
      colorHex: '#FFCC00',
      fontSizePx: 86,
      fontFamily: 'Georgia',
      alignment: 'left',
    });
  });

  it('treats gaps as implicit â€” absolute offsets already encode spacing', () => {
    const withGap = xml.replace('</spine>', '<gap offset="2s" duration="1s"/></spine>');
    const parsedGap = parseFcpxml(withGap);
    expect(parsedGap.unsupported).toHaveLength(0);
    expect(parsedGap.clips.every((c) => c.startFrame >= 0)).toBe(true);
  });
});


