/**
 * Round-trip coverage for the FCPXML interchange (#154): export a fixture
 * project, parse it back, and assert the supported subset survives — plus
 * foreign-format tolerance (rational times, gaps) and unsupported notes.
 */
import { describe, it, expect } from 'vitest';
import type { Project } from '../types/project';
import { EditorController } from '../editor/controller';
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

  it('treats gaps as implicit — absolute offsets already encode spacing', () => {
    const withGap = xml.replace('</spine>', '<gap offset="2s" duration="1s"/></spine>');
    const parsedGap = parseFcpxml(withGap);
    expect(parsedGap.unsupported).toHaveLength(0);
    expect(parsedGap.clips.every((c) => c.startFrame >= 0)).toBe(true);
  });
});

/**
 * `enabled` and `audioRole` are the two spine-element attributes this editor has
 * no field for at all, so they are reported rather than dropped without a word.
 *
 * Both are calibrated against what the FORMAT and OUR OWN WRITER actually
 * express, because a per-element note for a value every element carries is a note
 * per element on every document and would bury every other omission in the list:
 *
 * - `enabled` is the element's own on/off state. `enabled="1"` is what the writer
 *   puts on every element it emits, so it states nothing; only a DISABLED element
 *   is reported. The model has no per-clip enabled flag either — `Track.visible`
 *   is the nearest field and switching a whole track off is not the same
 *   statement as disabling one element — so this is unrepresentable, not a
 *   missing mapping.
 * - `audioRole` designates which standard audio role a clip carries.
 *   `Clip` has no role field. `dialogue` is what the writer puts on EVERY audio
 *   element, so it is the quiet case; any other designation is information a
 *   third-party document authored and this editor cannot hold.
 */
describe('#154 unrepresentable spine-element attributes', () => {
  const spine = (attrs: string, body = ''): string => [
    '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE fcpxml>',
    '<fcpxml version="1.11"><resources>',
    '<format id="r1" frameDuration="1/30s" width="1920" height="1080"/>',
    '<asset id="2" name="clip.mp4" src="file:///X:/media/clip.mp4" start="0s" duration="10s"'
    + ' hasVideo="1" hasAudio="1" format="r1"/>',
    '<asset id="3" name="music.wav" src="file:///X:/media/music.wav" start="0s" duration="10s" hasAudio="1"/>',
    '</resources><library><event name="E"><project name="E"><spine>',
    `<asset-clip ref="2" name="Take 1" lane="0" offset="0s" start="0s" duration="1s"${attrs}>${body}</asset-clip>`,
    '</spine></project></event></library></fcpxml>',
  ].join('');

  it('reports a DISABLED element and a non-default audio role, verbatim', () => {
    expect(parseFcpxml(spine(' enabled="0"')).unsupported).toEqual([
      'Asset-clip "Take 1" is disabled (enabled="0"); the disabled state is not imported.',
    ]);
    expect(parseFcpxml(spine(' audioRole="music"')).unsupported).toEqual([
      'Asset-clip "Take 1" has audioRole="music"; audio roles are not imported.',
    ]);
    // Both on one element, both reported, in the order they are read.
    expect(parseFcpxml(spine(' enabled="0" audioRole="narration"')).unsupported).toEqual([
      'Asset-clip "Take 1" is disabled (enabled="0"); the disabled state is not imported.',
      'Asset-clip "Take 1" has audioRole="narration"; audio roles are not imported.',
    ]);
  });

  it('is quiet for the values our own writer puts on every element', () => {
    // The premise, pinned on the XML itself: these are exactly the values
    // `renderAsset`/`renderTitle`/`renderCompound` write.
    expect(parseFcpxml(spine(' enabled="1" audioRole="dialogue"')).unsupported).toEqual([]);
    // Absent, which is the same two statements.
    expect(parseFcpxml(spine('')).unsupported).toEqual([]);
  });

  it('reports the same two attributes on a title and on a ref-clip', () => {
    const withTitle = [
      '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE fcpxml>',
      '<fcpxml version="1.11"><resources>',
      '<format id="r1" frameDuration="1/30s" width="1920" height="1080"/>',
      '<text-style-def id="ts1"><text-style font="sans-serif" fontSize="50"'
      + ' fontColor="#FFFFFF" alignment="CENTER"/></text-style-def>',
      '</resources><library><event name="E"><project name="E"><spine>',
      '<title ref="ts1" name="Cap" lane="0" offset="0s" start="0s" duration="1s" enabled="0">'
      + '<text><text-style ref="ts1">Hello</text-style></text></title>',
      '</spine></project></event></library></fcpxml>',
    ].join('');
    expect(parseFcpxml(withTitle).unsupported).toEqual([
      'Title "Cap" is disabled (enabled="0"); the disabled state is not imported.',
    ]);

    const withCarrier = [
      '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE fcpxml>',
      '<fcpxml version="1.11"><resources>',
      '<format id="r1" frameDuration="1/30s" width="1920" height="1080"/>',
      '<asset id="2" name="clip.mp4" src="file:///X:/media/clip.mp4" start="0s" duration="10s" hasVideo="1"/>',
      '<media id="nest1" name="Nest"><sequence format="r1" duration="1s" tcStart="0s">',
      '<spine><gap name="Timeline" offset="0s" start="0s" duration="1s">',
      '<asset-clip ref="2" name="Inner" lane="1" offset="0s" start="0s" duration="1s"/>',
      '</gap></spine></sequence></media>',
      '</resources><library><event name="E"><project name="E"><spine>',
      '<ref-clip ref="nest1" name="Nest" lane="1" offset="0s" start="0s" duration="1s"'
      + ' enabled="0" audioRole="sfx"/>',
      '</spine></project></event></library></fcpxml>',
    ].join('');
    // The carrier itself imports, so the two notes describe a clip that DOES
    // arrive without them.
    const carrierPlan = parseFcpxml(withCarrier);
    expect(carrierPlan.sequences?.[0]?.clips).toHaveLength(1);
    expect(carrierPlan.unsupported).toEqual([
      'Ref-clip "Nest" is disabled (enabled="0"); the disabled state is not imported.',
      'Ref-clip "Nest" has audioRole="sfx"; audio roles are not imported.',
    ]);
  });

  it('adds nothing to a real exported document, flat or compound', () => {
    // The calibration, measured rather than asserted: a palmier project round
    // trips with an EMPTY unsupported list, which is what keeps the amber
    // "Not imported" box meaningful. The flat writer stamps audioRole="dialogue"
    // on every audio element and the compound writer stamps enabled="1" on every
    // element, so an uncalibrated report would fire here and on every user import.
    const flat = exportFcpxml(fixtureProject());
    expect(flat).toContain('audioRole="dialogue"');
    expect(parseFcpxml(flat).unsupported).toEqual([]);

    const editor = new EditorController();
    editor.addMedia({
      id: 'v', path: 'C:/media/footage.mp4', filename: 'footage.mp4', type: 'video',
      duration: 60, width: 1920, height: 1080, fileSize: 1, addedAt: '2026-08-26T00:00:00.000Z',
      audioCodec: 'aac', channels: 2, sampleRate: 48000,
    });
    const leaf = editor.addClip({ assetId: 'v', trackId: 'v1', startFrame: 0, durationFrames: 30 });
    editor.trimClip(leaf, 15, 45);
    editor.nestClips([leaf], { name: 'Nest' });
    const compound = exportFcpxml(editor.getProject());
    expect(compound).toContain('enabled="1"');
    expect(parseFcpxml(compound).unsupported).toEqual([]);
  });

  it('still reports a disabled element in a document our writer produced', () => {
    // `enabledFor` is the COMPOUND writer's only source of `enabled` — it reads the
    // owning track's `visible` — and the flat writer omits the attribute
    // entirely. So a hidden track inside a nest is what puts `enabled="0"` in a
    // file, and the materializers synthesize fresh visible tracks, so the state
    // is genuinely lost and the note is the only trace of it.
    const project = fixtureProject();
    project.timeline.tracks[2]!.visible = false;
    const flatXml = exportFcpxml(project);
    expect(flatXml).not.toContain('enabled="0"');

    const editor = new EditorController();
    editor.addMedia({
      id: 'v', path: 'C:/media/footage.mp4', filename: 'footage.mp4', type: 'video',
      duration: 60, width: 1920, height: 1080, fileSize: 1, addedAt: '2026-08-26T00:00:00.000Z',
    });
    const leaf = editor.addClip({ assetId: 'v', trackId: 'v1', startFrame: 0, durationFrames: 30 });
    editor.trimClip(leaf, 15, 45);
    editor.nestClips([leaf], { name: 'Nest' });
    const nested = editor.getProject().timelines!;
    const nestId = Object.keys(nested)[0]!;
    nested[nestId]!.tracks[0]!.visible = false;
    const compound = exportFcpxml(editor.getProject());
    expect(compound).toContain('enabled="0"');

    const plan = parseFcpxml(compound);
    // Measured on that real export: the leaf AND the carrier that holds it both
    // carry `enabled="0"`, so both are named. Two notes for one hidden track, not
    // one per element in the document — the calibration above is what keeps it
    // there instead of on every import.
    expect(plan.unsupported).toEqual([
      'Asset-clip "footage.mp4" is disabled (enabled="0"); the disabled state is not imported.',
      'Ref-clip "Nest" is disabled (enabled="0"); the disabled state is not imported.',
    ]);
    // The clips themselves still arrive: the note reports the state, it does not skip.
    expect(plan.sequences?.[0]?.clips).toHaveLength(1);
    expect(plan.clips).toHaveLength(1);
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


