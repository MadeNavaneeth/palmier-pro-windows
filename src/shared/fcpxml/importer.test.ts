/**
 * Round-trip coverage for the FCPXML interchange (#154): export a fixture
 * project, parse it back, and assert the supported subset survives â€” plus
 * foreign-format tolerance (rational times, gaps) and unsupported notes.
 */
import { describe, it, expect } from 'vitest';
import type { Project } from '../types/project';
import { exportFcpxml } from './exporter';
import {
  isImportedCompoundClip,
  parseFcpxml,
  parseFcpxmlTime,
} from './importer';
import { MAX_COMPOUND_DEPTH } from '../editor/compound';

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
    { id: 'a', path: 'C:/media/footage.mp4', filename: 'footage.mp4', type: 'video', duration: 60, fileSize: 1, addedAt: '', width: 1920, height: 1080, audioCodec: 'aac', startTimecode: '01:00:00:00' },
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

  it('recovers the source start timecode (#154)', () => {
    const footage = parsed.assets.find((a) => a.path === 'C:/media/footage.mp4');
    expect(footage?.startTimecode).toBe('01:00:00:00');
    // An asset without a timecode stays without one.
    const music = parsed.assets.find((a) => a.path === 'C:/media/music.wav');
    expect(music?.startTimecode).toBeUndefined();
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

describe('compound FCPXML import safety', () => {
  function document(resources: string, rootRef: string): string {
    return [
      '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE fcpxml>',
      '<fcpxml version="1.11"><resources>',
      '<format id="r1" frameDuration="1/30s" width="1920" height="1080"/>',
      resources,
      '</resources><library><event name="Compound"><project name="Compound"><spine>',
      `<ref-clip ref="${rootRef}" name="Carrier" lane="1" offset="1s" start="0s" duration="1s"/>`,
      '</spine></project></event></library></fcpxml>',
    ].join('');
  }

  function sequence(ref: string, body: string, duration = '1s'): string {
    return `<media id="${ref}" name="${ref}"><sequence format="r1" duration="${duration}" tcStart="0s">`
      + `<spine><gap name="Timeline" offset="0s" start="0s" duration="${duration}">${body}</gap></spine>`
      + '</sequence></media>';
  }

  it('pins the flat plan shape when no compound structure is present', () => {
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE fcpxml>',
      '<fcpxml version="1.11"><resources>',
      '<format id="r1" frameDuration="1/30s" width="1920" height="1080"/>',
      '<asset id="2" name="clip.mp4" src="file:///X:/clip.mp4" start="0s" duration="10s" hasVideo="1" format="r1"/>',
      '</resources><library><event name="Flat"><project name="Flat"><spine>',
      '<asset-clip ref="2" name="Clip" lane="0" offset="0.5s" start="1s" duration="2s"/>',
      '</spine></project></event></library></fcpxml>',
    ].join('');

    expect(parseFcpxml(xml)).toEqual({
      name: 'Flat',
      fps: 30,
      width: 1920,
      height: 1080,
      assets: [{
        ref: '2',
        path: 'X:/clip.mp4',
        hasVideo: true,
        hasAudio: false,
        durationSec: 10,
      }],
      clips: [{
        kind: 'video',
        lane: 0,
        startFrame: 15,
        durationFrames: 60,
        sourceInFrame: 30,
        assetPath: 'X:/clip.mp4',
        label: 'Clip',
      }],
      unsupported: [],
    });
  });

  it('reports an unresolvable ref and creates no sequence or carrier', () => {
    const plan = parseFcpxml(document('', 'missing'));

    expect(plan.clips).toEqual([]);
    expect(plan.sequences).toBeUndefined();
    expect(plan.unsupported.some((note) => /unknown sequence resource "missing"/.test(note))).toBe(true);
  });

  it('reports a resource cycle without recursing forever or emitting a partial graph', () => {
    const resources = sequence(
      'a',
      '<ref-clip ref="b" name="A to B" lane="1" offset="0s" start="0s" duration="1s"/>',
    ) + sequence(
      'b',
      '<ref-clip ref="a" name="B to A" lane="1" offset="0s" start="0s" duration="1s"/>',
    );

    const plan = parseFcpxml(document(resources, 'a'));

    expect(plan.clips).toEqual([]);
    expect(plan.sequences).toBeUndefined();
    expect(plan.unsupported.some((note) => /cycle/i.test(note))).toBe(true);
  });

  it('reports depth overflow without walking beyond the domain cap', () => {
    const resources = Array.from({ length: MAX_COMPOUND_DEPTH + 1 }, (_, index) => {
      const child = index < MAX_COMPOUND_DEPTH
        ? `<ref-clip ref="level-${index + 1}" name="Level ${index + 1}" lane="1" offset="0s" start="0s" duration="1s"/>`
        : '';
      return sequence(`level-${index}`, child);
    }).join('');

    const plan = parseFcpxml(document(resources, 'level-0'));

    expect(plan.clips).toEqual([]);
    expect(plan.sequences).toBeUndefined();
    expect(plan.unsupported.some((note) => /maximum nested depth/i.test(note))).toBe(true);
  });

  it('marks a parsed ref-clip as a compound carrier without changing flat video typing', () => {
    const resources = '<asset id="2" name="clip.mp4" src="file:///X:/clip.mp4" duration="10s" hasVideo="1"/>'
      + sequence(
        'nest1',
        '<asset-clip ref="2" name="Inner" lane="1" offset="0s" start="0s" duration="1s"/>',
      );
    const plan = parseFcpxml(document(resources, 'nest1'));
    const carrier = plan.clips[0];

    expect(isImportedCompoundClip(carrier!)).toBe(true);
    expect(plan.sequences).toHaveLength(1);
    expect(plan.sequences?.[0]?.clips[0]).toMatchObject({
      kind: 'video',
      startFrame: 0,
      durationFrames: 30,
      sourceInFrame: 0,
    });
  });
});


