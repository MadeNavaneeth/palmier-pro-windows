/**
 * Round-trip coverage for the FCPXML interchange (#154): export a fixture
 * project, parse it back, and assert the supported subset survives — plus
 * foreign-format tolerance (rational times, gaps) and unsupported notes.
 */
import { describe, it, expect } from 'vitest';
import type { Project } from '../types/project';
import { EditorController } from '../editor/controller';
import { exportFcpxml } from './exporter';
import { applyFcpxmlPlan } from './apply';
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

/**
 * The remaining constructs this importer reads for nothing.
 *
 * Every element name here is quoted from Apple's published FCPXML DTD, and the
 * list is grouped by the DTD group that makes it legal, so coverage can be checked
 * against the group rather than against this test. Two rules govern it:
 *
 * - ONE note per document per element, not per element occurrence, because our
 *   writer emits none of them and a per-element note would be a note per clip on
 *   any real project. The calibration test below is what holds that line.
 * - An attribute is reported only when its value is not an effective default.
 *   `enabled="1"`, `audioRole="dialogue"` and `videoRole="video"` state nothing;
 *   `srcEnable` states something but is not reported at all, because the
 *   compound writer puts `srcEnable="video"` on every `<ref-clip>` it emits.
 */
describe('#154 constructs read for nothing', () => {
  const CLIP_PATH = 'X:/media/clip.mp4';

  function document(spine: string, asset = '', eventTail = ''): string {
    return [
      '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE fcpxml>',
      '<fcpxml version="1.11"><resources>',
      '<format id="r1" frameDuration="1/30s" width="1920" height="1080"/>',
      asset || `<asset id="2" name="clip.mp4" src="file:///${CLIP_PATH}" start="0s"`
        + ' duration="10s" hasVideo="1" hasAudio="1" format="r1"/>',
      '</resources><library><event name="E"><project name="E"><spine>',
      spine,
      // `eventTail` goes where a collection legally lives: `%event_item` includes
      // `%collection_item`, so a <keyword-collection> is a sibling of <project>.
      `</spine></project>${eventTail}</event></library></fcpxml>`,
    ].join('');
  }

  const withBody = (body: string, attrs = ''): string =>
    document(`<asset-clip ref="2" name="Take 1" lane="0" offset="0s" start="0s" duration="1s"${attrs}>${body}</asset-clip>`);

  it('reports every declared element, quoted from the DTD, once per document', () => {
    const cases: Array<[string, string]> = [
      // %marker_item "(marker | chapter-marker | rating | keyword | analysis-marker)"
      ['marker', '<marker start="0s" duration="1s" value="Pick"/>'],
      ['rating', '<rating start="0s" value="favorite"/>'],
      ['keyword', '<keyword start="0s" value="interview, a-roll"/>'],
      ['analysis-marker', '<analysis-marker start="0s"><shot-type value="onePerson"/></analysis-marker>'],
      // The DTD renamed these between versions; this module targets 1.11, so a
      // reader must report what a document contains, not only the newest name.
      ['audio-channel-source', '<audio-channel-source srcCh="1,2" outCh="L,R" role="dialogue"/>'],
      ['audio-role-source', '<audio-role-source role="dialogue"/>'],
      ['audio-source', '<audio-source srcCh="1" outCh="L" role="dialogue"/>'],
      ['audio-aux-source', '<audio-aux-source srcCh="3" outCh="Ls" role="sfx"/>'],
      // Legal only inside the routing elements, and a time-RANGED suppression,
      // which is a different thing from Clip.muted.
      ['mute', '<audio-channel-source srcCh="1"><mute start="0s" duration="1s"/></audio-channel-source>'],
      // %intrinsic-params-video members added after the first pass
      ['adjust-360-transform', '<adjust-360-transform coordinates="spherical" latitude="1"/>'],
      ['adjust-reorient', '<adjust-reorient tilt="5" pan="0" roll="0"/>'],
      ['adjust-orientation', '<adjust-orientation tilt="5" fieldOfView="45"/>'],
      ['adjust-cinematic', '<adjust-cinematic aperture="2.8"/>'],
      ['object-tracker', '<object-tracker><tracking-shape id="t1" name="T"/></object-tracker>'],
      // Library organisation: no timeline content, still a construct the imported
      // project will not have. `%event_item` includes `%collection_item`, so these
      // are siblings of <project> inside <event>, not children of a spine element.
      ['keyword-collection', '<keyword-collection name="Good takes"/>'],
      ['collection-folder', '<collection-folder name="B-roll"/>'],
      ['smart-collection', '<smart-collection name="Long" match="all">'
        + '<match-media enabled="1" rule="isNot" type="videoOnly"/></smart-collection>'],
      ['import-options', '<import-options><option key="copyMedia" value="0"/></import-options>'],
      // <asset> children. media-rep is where 1.10 moved `src`.
      ['media-rep', `<media-rep kind="original-media" src="file:///${CLIP_PATH}"/>`],
      ['bookmark', '<bookmark>clipbookmark</bookmark>'],
      ['metadata', '<metadata><md key="com.apple.FinalCutPro.SmartClip" value="x"/></metadata>'],
    ];

    for (const [element, body] of cases) {
      const isLibrary = ['keyword-collection', 'collection-folder', 'smart-collection', 'import-options']
        .includes(element);
      const plan = parseFcpxml(document(
        `<asset-clip ref="2" name="Take 1" lane="0" offset="0s" start="0s" duration="1s">${isLibrary ? '' : body}</asset-clip>`,
        '',
        isLibrary ? body : '',
      ));
      expect(plan.unsupported, element).toContain(`${element} elements are skipped.`);
      // The clip still arrives: the note reports, it does not skip the element.
      expect(plan.clips, element).toHaveLength(1);
    }
  });

  it('matches on an element-name boundary, so keyword does not catch keyword-collection', () => {
    // `keyword` and `keyword-collection` are both on the list, and the older
    // construct scan is a plain substring test, so a naive scan would report
    // `keyword` for a document that only declares a keyword collection.
    const collectionOnly = parseFcpxml(document(
      '<asset-clip ref="2" name="Take 1" lane="0" offset="0s" start="0s" duration="1s"/>',
      '',
      '<keyword-collection name="Good takes"/>',
    ));
    expect(collectionOnly.unsupported).toEqual(['keyword-collection elements are skipped.']);

    // And a real marker still reports only itself.
    const marker = parseFcpxml(withBody('<keyword start="0s" value="a"/>'));
    expect(marker.unsupported).toEqual(['keyword elements are skipped.']);
  });

  it('gives filter-video-mask exactly ONE note, from the older construct scan', () => {
    // That scan is a plain substring test and `'<filter-video'` is a prefix of
    // `filter-video-mask`, so it is already covered. `filter-video-mask` is
    // deliberately NOT in UNREPRESENTED_ELEMENTS: adding it would double-report.
    const plan = parseFcpxml(withBody('<filter-video-mask><mask-shape name="M"/></filter-video-mask>'));
    expect(plan.unsupported).toEqual(['filter-video elements are skipped.']);
  });

  it('leaves the spine-level constructs to the spine reporter, with no second note', () => {
    // caption / sync-clip / audio are %clip_item members, so at spine level
    // `reportSpineElement` already names each one. Adding them to the scan would
    // double-report the common case; only their ANCHORED form is a gap.
    for (const [kind, spine] of [
      ['caption', '<caption name="CC" ref="2" lane="0" offset="0s" duration="1s"/>'],
      ['sync-clip', '<sync-clip name="S" ref="2" lane="0" offset="0s" duration="1s"/>'],
      ['audio', '<audio name="A" ref="2" lane="-1" offset="0s" duration="1s"/>'],
    ] as const) {
      const plan = parseFcpxml(document(spine));
      expect(plan.unsupported, kind).toEqual([
        `Spine element "<${kind}>" "${kind === 'sync-clip' ? 'S' : kind === 'audio' ? 'A' : 'CC'}" is not imported; it is skipped.`,
      ]);
    }
  });

  it('reports the clip attributes that state something, and is quiet on the defaults', () => {
    expect(parseFcpxml(withBody('', ' audioStart="0.5s"')).unsupported).toEqual([
      'Asset-clip "Take 1" has a J/L split edit (audioStart/audioDuration); split edits are not imported.',
    ]);
    // A duration with no start is still a statement about the audio window.
    expect(parseFcpxml(withBody('', ' audioDuration="2s"')).unsupported).toEqual([
      'Asset-clip "Take 1" has a J/L split edit (audioStart/audioDuration); split edits are not imported.',
    ]);
    expect(parseFcpxml(withBody('', ' videoRole="titles"')).unsupported).toEqual([
      'Asset-clip "Take 1" has videoRole="titles"; video roles are not imported.',
    ]);
    expect(parseFcpxml(withBody('', ' useAudioSubroles="1"')).unsupported).toEqual([
      'Asset-clip "Take 1" sets useAudioSubroles="1"; role-based sub-audio is not imported.',
    ]);
    // The documented defaults state nothing.
    expect(parseFcpxml(withBody('', ' videoRole="video" useAudioSubroles="0"')).unsupported).toEqual([]);
    // srcEnable is read for nothing and is DELIBERATELY not reported: the compound
    // writer emits srcEnable="video" on every <ref-clip> it writes, so a note here
    // would fire on every palmier round trip. A foreign producer's srcEnable is a
    // real omission and is recorded as open in the ledgers.
    expect(parseFcpxml(withBody('', ' srcEnable="video" srcEnable="audio"')).unsupported).toEqual([]);
  });

  it('reports the asset component and colour attributes, per asset', () => {
    const withAsset = (attrs: string) =>
      parseFcpxml(document(
        '<asset-clip ref="2" name="Take 1" lane="0" offset="0s" start="0s" duration="1s"/>',
        `<asset id="2" name="clip.mp4" src="file:///${CLIP_PATH}" start="0s" duration="10s" hasVideo="1"${attrs}/>`,
      ));
    // Per asset, not per document: WHICH asset is the actionable part, and a
    // location-sound document states these on its recordings and not its B-roll.
    expect(withAsset(' videoSources="2" audioSources="4" audioChannels="4" audioRate="48000"').unsupported)
      .toEqual([
        'Asset 2 declares videoSources, audioSources, audioChannels, audioRate;'
        + ' its media component layout is not imported, and the asset is placed as one clip.',
      ]);
    // MediaAsset.channels and MediaAsset.sampleRate DO ship, so audioChannels and
    // audioRate are a shipped field not being transported.
    expect(withAsset(' colorSpaceOverride="Rec. 709 (sRGB)" stereoscopicOverride="mono"').unsupported)
      .toEqual([
        'Asset 2 declares colorSpaceOverride, stereoscopicOverride;'
        + ' colour-management overrides are not imported.',
      ]);
    // A plain asset states none of it.
    expect(withAsset('').unsupported).toEqual([]);
  });

  it('does NOT report channel routing as pan, because routing is not balance', () => {
    // `srcCh`/`outCh` is a ROUTING matrix: which source channel feeds which output
    // bus (L,R,C,LFE,Ls,Rs,X), and the model has no field for it. `Clip.pan` is a
    // stereo BALANCE, -1 hard left … +1 hard right, which is a different concept:
    // mapping a route onto it would fabricate a value rather than omit one. The
    // requirement is the absence of any mapping, so that is what is asserted.
    const plan = parseFcpxml(withBody(
      '<audio-channel-source srcCh="1,2" outCh="Ls,Rs" role="dialogue"/>',
    ));
    expect(plan.unsupported).toEqual(['audio-channel-source elements are skipped.']);

    const target = new EditorController();
    target.addMedia({
      id: 'imported', path: CLIP_PATH, filename: 'clip.mp4', type: 'video', duration: 300,
      width: 1920, height: 1080, fileSize: 1, addedAt: '2026-01-01T00:00:00.000Z',
    });
    applyFcpxmlPlan(target, plan, new Map([[CLIP_PATH, 'imported']]));
    const placed = target.getClips()[0]!;
    // No new field, and no `pan` invented from a route.
    expect(placed.pan).toBeUndefined();
    expect(placed.volume).toBe(1);
  });

  it('does NOT report a construct the DTD does not declare', () => {
    // Withdrawn as phantoms in an earlier pass, after being named from memory
    // rather than from the DTD. `asset@audioSources` and `asset@videoSources` are
    // real ATTRIBUTES, not the elements that were listed; there is no
    // `asset@hasMarkers` and no `asset@matches`; there is no `<keywords>`
    // element; and FCPXML has no metronome and no `<rate>` element (it has
    // `conform-rate` and an `asset@audioRate` attribute). Asserted absent so a
    // phantom cannot creep back into the list.
    const plan = parseFcpxml(document(
      '<asset-clip ref="2" name="Take 1" lane="0" offset="0s" start="0s" duration="1s">'
      + '<metronome duration="1s"/><rate><timept time="0s" value="24s"/></rate>'
      + '<keywords name="a,b"/><videoSources src="a"/><audioSources src="b"/>'
      + '</asset-clip>',
      `<asset id="2" name="clip.mp4" src="file:///${CLIP_PATH}" start="0s" duration="10s"`
      + ' hasVideo="1" hasMarkers="1" matches="**"/>',
    ));
    expect(plan.unsupported).toEqual([]);
    // audioSources/videoSources on the ASSET are real, though, and are reported.
    const real = parseFcpxml(document(
      '<asset-clip ref="2" name="Take 1" lane="0" offset="0s" start="0s" duration="1s"/>',
      `<asset id="2" name="clip.mp4" src="file:///${CLIP_PATH}" start="0s" duration="10s"`
      + ' hasVideo="1" videoSources="2" audioSources="2"/>',
    ));
    expect(real.unsupported).toEqual([
      'Asset 2 declares videoSources, audioSources;'
      + ' its media component layout is not imported, and the asset is placed as one clip.',
    ]);
  });

  it('reports nothing new on a real document our writer produced, flat or compound', () => {
    // The calibration that makes every entry above safe, measured rather than
    // asserted. A clip carrying every adjust element, attribute and field this
    // writer CAN emit, on both export paths.
    const flat = new EditorController();
    flat.addMedia({
      id: 'v', path: CLIP_PATH, filename: 'clip.mp4', type: 'video', duration: 300,
      width: 1920, height: 1080, fileSize: 1, addedAt: '2026-01-01T00:00:00.000Z',
      audioCodec: 'aac', channels: 2, sampleRate: 48000,
    });
    flat.addMedia({
      id: 'a', path: 'X:/media/music.wav', filename: 'music.wav', type: 'audio',
      duration: 300, fileSize: 1, addedAt: '2026-01-01T00:00:00.000Z',
    });
    const videoId = flat.addClip({ assetId: 'v', trackId: 'v1', startFrame: 0, durationFrames: 60 });
    flat.addClip({ assetId: 'a', trackId: 'a1', startFrame: 0, durationFrames: 60 });
    flat.addTitleClip({ trackId: 'v2', text: 'Cap', startFrame: 0, durationFrames: 30 });
    flat.applyClipProperties([videoId], 'kitchen sink', (draft) => {
      draft.opacity = 0.4; draft.x = 10; draft.y = 20;
      draft.width = 800; draft.height = 450; draft.rotation = 5;
      draft.crop = { left: 0.1, right: 0, top: 0.05, bottom: 0 };
      draft.volume = 0.5; draft.blendMode = 'multiply'; draft.fadeInFrames = 6;
      draft.motionX = [{ frame: 0, value: 0 }, { frame: 30, value: 40 }];
      return true;
    });
    flat.setClipSpeed(videoId, 2);
    const flatXml = exportFcpxml(flat.getProject());
    // The premise: every construct this writer emits, and none of the new list.
    expect(flatXml).toContain('audioRole="dialogue"');
    expect(flatXml).toContain('<adjust-blend amount="0.4"/>');
    expect(flatXml).toContain('<adjust-crop mode="trim">');
    expect(flatXml).toContain('<adjust-volume amount="-6.0206dB"/>');
    expect(flatXml).toContain('<adjust-transform');
    expect(flatXml).toContain('<adjust-conform type="fit"/>');
    expect(flatXml).toContain('<timeMap');
    for (const phantom of ['<marker', '<rating', '<keyword', '<audio-channel-source',
      '<audio-role-source', '<mute', '<metadata', '<media-rep', '<smart-collection',
      'audioStart=', 'videoRole=', 'useAudioSubroles=', 'audioSources=', 'colorSpaceOverride=']) {
      expect(flatXml, phantom).not.toContain(phantom);
    }
    expect(parseFcpxml(flatXml).unsupported).toEqual([]);

    // The compound path additionally writes `srcEnable="video"` on every carrier
    // and `audioRate` on every <sequence> — the two needles that made a
    // document-wide attribute scan unsafe, which is why the asset attributes are
    // read per asset instead.
    const compound = new EditorController();
    compound.addMedia({
      id: 'v', path: CLIP_PATH, filename: 'clip.mp4', type: 'video', duration: 300,
      width: 1920, height: 1080, fileSize: 1, addedAt: '2026-01-01T00:00:00.000Z',
      audioCodec: 'aac', channels: 2, sampleRate: 48000,
    });
    const leaf = compound.addClip({ assetId: 'v', trackId: 'v1', startFrame: 0, durationFrames: 30 });
    compound.trimClip(leaf, 15, 45);
    compound.nestClips([leaf], { name: 'Nest' });
    const compoundXml = exportFcpxml(compound.getProject());
    expect(compoundXml).toContain('srcEnable="video"');
    expect(compoundXml).toContain('audioRate="48k"');
    expect(parseFcpxml(compoundXml).unsupported).toEqual([]);
  });

});

describe('#154 two parse defects closed', () => {
  const selfClosing = (id: string, name: string) =>
    `<asset id="${id}" name="${name}" src="file:///X:/media/${name}" start="0s" duration="10s" hasVideo="1"/>`;
  const paired = (id: string, name: string) =>
    `<asset id="${id}" name="${name}" src="file:///X:/media/${name}" start="0s" duration="10s" hasVideo="1">`
    + '<timecode start="3600s" duration="10s" format="r1"/></asset>';
  const clipTo = (ref: string, name: string, offset: number) =>
    `<asset-clip ref="${ref}" name="${name}" lane="0" offset="${offset}s" start="0s" duration="1s"/>`;

  function doc(resources: string, spine: string) {
    return [
      '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE fcpxml>',
      '<fcpxml version="1.11"><resources>',
      '<format id="r1" frameDuration="1/30s" width="1920" height="1080"/>',
      resources,
      '</resources><library><event name="E"><project name="E"><spine>',
      spine,
      '</spine></project></event></library></fcpxml>',
    ].join('');
  }

  it('reads every asset in EVERY ordering, self-closing or paired', () => {
    // The defect: `extractTagBlock`'s `[^>]*` is GREEDY, so on `<asset ... />` it
    // eats the terminating `/` before the alternation gets a chance to try `/>`.
    // `/>` therefore only ever matched by BACKTRACKING, which is to say only when
    // no later `</asset>` existed to satisfy the long form instead. A self-closing
    // asset followed by a paired one therefore matched all the way to the paired
    // one's `</asset>`, swallowing the first asset whole and reporting the second
    // clip as an unknown resource.
    //
    // Reachable from a palmier project, not only a foreign one: our writer emits a
    // PAIRED asset (one with a `<timecode>` child) exactly when the asset carries
    // `MediaAsset.startTimecode`, so which asset is paired is decided by the order
    // the user happened to import their media in.
    const spine2 = clipTo('2', 'A', 0) + clipTo('3', 'B', 1);
    const spine3 = spine2 + clipTo('4', 'C', 2);

    // All self-closing: the common case, and what our writer emits for every asset
    // without a source timecode.
    const allSelfClosing = parseFcpxml(doc(selfClosing('2', 'a.mp4') + selfClosing('3', 'b.mp4'), spine2));
    expect(allSelfClosing.assets.map((a) => a.ref)).toEqual(['2', '3']);
    expect(allSelfClosing.clips).toHaveLength(2);
    expect(allSelfClosing.unsupported).toEqual([]);

    // Paired FIRST: worked before and must keep working.
    const pairedFirst = parseFcpxml(doc(paired('2', 'a.mp4') + selfClosing('3', 'b.mp4'), spine2));
    expect(pairedFirst.assets.map((a) => a.ref)).toEqual(['2', '3']);
    expect(pairedFirst.clips).toHaveLength(2);
    expect(pairedFirst.unsupported).toEqual([]);

    // Self-closing FIRST, paired SECOND: this was the data loss.
    const swallowed = parseFcpxml(doc(selfClosing('2', 'a.mp4') + paired('3', 'b.mp4'), spine2));
    expect(swallowed.assets.map((a) => a.ref)).toEqual(['2', '3']);
    expect(swallowed.clips).toHaveLength(2);
    expect(swallowed.unsupported).toEqual([]);
    // And the paired asset's own timecode still arrives, so the fix is not a
    // refusal to read a paired block.
    expect(swallowed.assets.find((a) => a.ref === '3')?.startTimecode).toBe('01:00:00:00');

    // Interleaved, three assets, paired in the MIDDLE: the case where neither
    // "everything paired" nor "everything self-closing" reasoning finds the bug.
    const interleaved = parseFcpxml(doc(
      selfClosing('2', 'a.mp4') + paired('3', 'b.mp4') + selfClosing('4', 'c.mp4'),
      spine3,
    ));
    expect(interleaved.assets.map((a) => a.ref)).toEqual(['2', '3', '4']);
    expect(interleaved.clips).toHaveLength(3);
    expect(interleaved.unsupported).toEqual([]);

    // Two paired in a row, then a self-closing one.
    const pairedThenSelf = parseFcpxml(doc(
      paired('2', 'a.mp4') + paired('3', 'b.mp4') + selfClosing('4', 'c.mp4'),
      spine3,
    ));
    expect(pairedThenSelf.assets.map((a) => a.ref)).toEqual(['2', '3', '4']);
    expect(pairedThenSelf.clips).toHaveLength(3);
    expect(pairedThenSelf.unsupported).toEqual([]);
  });

  it('reads a > inside a quoted attribute value, which XML permits raw', () => {
    // Checked rather than assumed. XML forbids only `<` and `&` raw in an
    // attribute value, so `name="A > B"` is LEGAL, and the old `[^>]*` stopped at
    // the first `>` wherever it was. That left no position the alternatives could
    // satisfy, so the whole asset was lost rather than mis-parsed. Our own writer
    // escapes `>` (`escapeAttr`), so this is foreign-input-only.
    const plain = parseFcpxml(doc(
      '<asset id="2" name="A > B" src="file:///X:/media/a.mp4" start="0s" duration="10s" hasVideo="1"/>',
      clipTo('2', 'A', 0),
    ));
    expect(plain.assets.map((a) => a.ref)).toEqual(['2']);
    expect(plain.clips).toHaveLength(1);
    expect(plain.unsupported).toEqual([]);

    // And with a paired asset carrying that value, so a following `</asset>` is not
    // what makes it work.
    const pairedGt = parseFcpxml(doc(
      '<asset id="2" name="A > B" src="file:///X:/media/a.mp4" start="0s" duration="10s" hasVideo="1">'
      + '<timecode start="3600s" duration="10s" format="r1"/></asset>',
      clipTo('2', 'A', 0),
    ));
    expect(pairedGt.assets.map((a) => a.ref)).toEqual(['2']);
    expect(pairedGt.clips).toHaveLength(1);
    expect(pairedGt.unsupported).toEqual([]);
  });

  it('round-trips a project whose TIMECODE asset is not first, with nothing lost', () => {
    // The real-world shape of the defect, in the form it reaches a user: two video
    // assets where the SECOND carries a source timecode. Exported, re-imported, and
    // every asset and clip must still be there.
    //
    // The two-video shape is deliberate and measured. Resource ids are assigned in
    // CLIP order, not `media` order, and the exporter visits video before audio, so
    // putting the timecode on an AUDIO asset — or on the first video clip — always
    // emits the paired asset first, which is the one ordering the old regex handled.
    // A timecode on a LATER video clip is what puts a self-closing asset ahead of a
    // paired one, and that is the ordering that lost data.
    const p = baseProject();
    p.media.push(
      { id: 'a', path: 'C:/media/plain.mp4', filename: 'plain.mp4', type: 'video', duration: 60, fileSize: 1, addedAt: '', width: 1920, height: 1080, audioCodec: 'aac' },
      { id: 'b', path: 'C:/media/tc.mp4', filename: 'tc.mp4', type: 'video', duration: 60, fileSize: 1, addedAt: '', width: 1920, height: 1080, audioCodec: 'aac', startTimecode: '01:00:00:00' },
    );
    const clipBase = {
      label: 'Shot', trackId: 'v1', type: 'video' as const,
      startFrame: 0, durationFrames: 90, inPoint: 0, outPoint: 90,
      x: 0, y: 0, width: 1920, height: 1080, rotation: 0, scaleX: 1, scaleY: 1,
      opacity: 1, anchorX: 0, anchorY: 0, volume: 1, muted: false,
    };
    p.timeline.clips.push(
      { ...clipBase, id: 'c1', assetId: 'a' },
      { ...clipBase, id: 'c2', assetId: 'b', trackId: 'v2' },
    );

    const xml = exportFcpxml(p);
    // The precondition, asserted from the emitted document, so this test cannot
    // quietly stop covering the defect if the exporter's ordering ever changes: a
    // self-closing `<asset` really does precede the paired one.
    const block = xml.slice(xml.indexOf('<resources>'), xml.indexOf('</resources>'));
    const pairedAt = block.indexOf('src="file:///C:/media/tc.mp4"');
    expect(block.indexOf('<timecode ')).toBeGreaterThan(pairedAt);
    expect(block.lastIndexOf('<asset ', pairedAt)).toBeGreaterThan(block.indexOf('<asset '));

    const plan = parseFcpxml(xml);
    expect(plan.assets).toHaveLength(2);
    expect(plan.assets.find((a) => a.path === 'C:/media/tc.mp4')?.startTimecode).toBe('01:00:00:00');
    // The plain asset must NOT inherit the other one's timecode: pre-fix the
    // swallowed merged block handed `plain.mp4` the timecode that belongs to
    // `tc.mp4`, so this is a wrong value as well as a loss.
    expect(plan.assets.find((a) => a.path === 'C:/media/plain.mp4')?.startTimecode).toBeUndefined();
    expect(plan.clips).toHaveLength(2);
    expect(plan.unsupported).toEqual([]);
  });

  it('does NOT read a NESTED adjustment as the element own, for any of the four', () => {
    // The defect: `blendOf`, `volumeOf`, `cropTrimOf` and `transformOf` each
    // searched the spine element's WHOLE tag string, so an adjustment nested inside
    // a DIFFERENT element became the parent's. Measured, one per reader, inside
    // `<audio-channel-source srcCh="1" outCh="L">`:
    //
    //   adjust-volume    -6.0206dB  -> the clip arrived at volume 0.5
    //   adjust-blend      0.4       -> the clip arrived at opacity 0.4
    //   adjust-crop      trim       -> the clip arrived cropped
    //   adjust-transform 0.5 0.5    -> the clip arrived at that geometry
    //
    // A per-channel adjustment is the CHANNEL's, not the clip's, so applying it to
    // the parent is the same wrong-value class as the crop-mode bug. The fix is
    // scoping the four readers to the element's DIRECT children.
    const read = (body: string): Record<string, unknown> => {
      const plan = parseFcpxml(doc(
        '<asset id="2" name="clip.mp4" src="file:///X:/media/clip.mp4" start="0s" duration="10s" hasVideo="1" hasAudio="1"/>',
        `<asset-clip ref="2" name="Take 1" lane="0" offset="0s" start="0s" duration="1s">${body}</asset-clip>`,
      ));
      expect(plan.clips).toHaveLength(1);
      return plan.clips[0] as unknown as Record<string, unknown>;
    };
    const routing = (inner: string) => `<audio-channel-source srcCh="1" outCh="L">${inner}</audio-channel-source>`;

    // Nothing nested sets the parent's field: the plan carries no such key at all.
    expect(read(routing('<adjust-volume amount="-6.0206dB"/>')).volume).toBeUndefined();
    expect(read(routing('<adjust-blend amount="0.4"/>')).opacity).toBeUndefined();
    expect(read(routing('<adjust-crop mode="trim"><trim-rect left="10" top="5" right="0" bottom="0"/></adjust-crop>')).cropTrim)
      .toBeUndefined();
    expect(read(routing('<adjust-transform scale="0.5 0.5" position="10 10"/>')).transform)
      .toBeUndefined();

    // A DIRECT child is still read, which is the point of scoping rather than
    // ignoring: this is how every real adjustment arrives, and these four readers
    // are how the majority of an imported clip's look is transported.
    expect(read('<adjust-volume amount="-6.0206dB"/>').volume).toBeCloseTo(0.5, 4);
    expect(read('<adjust-blend amount="0.4"/>').opacity).toBe(0.4);
    expect(read('<adjust-crop mode="trim"><trim-rect left="10" top="5" right="0" bottom="0"/></adjust-crop>').cropTrim)
      .toEqual({ left: 10, top: 5, right: 0, bottom: 0 });
    expect(read('<adjust-transform scale="0.5 0.5" position="10 10"/>').transform)
      .toEqual({ positionX: 10, positionY: 10, scaleX: 0.5, scaleY: 0.5, rotation: 0 });
  });

  it('REPORTS an anchored element own nested adjustment, and does not set the parent', () => {
    // The anchored form produced no note at all before:
    //
    //   <ref-clip ref="2" ...><adjust-volume amount="-20dB"/></ref-clip>
    //     -> the parent clip arrived at volume 0.1, unsupported === []
    //
    // An anchored sub-clip's level is not the parent's, so it is not applied — and
    // a document stating an adjustment this importer cannot apply is exactly what
    // the omission reporting exists for, so it is now said.
    // The anchored form: a ref-clip NESTED INSIDE the asset-clip, as an anchored
    // sub-clip. Its level is the sub-clip's, not the parent's. Pre-fix the parent
    // arrived at volume 0.1 with `unsupported` empty, because the whole-string
    // search found the adjustment two levels down.
    const anchored = parseFcpxml(doc(
      '<asset id="2" name="clip.mp4" src="file:///X:/media/clip.mp4" start="0s" duration="10s" hasVideo="1" hasAudio="1"/>',
      '<asset-clip ref="2" name="Take 1" lane="0" offset="0s" start="0s" duration="1s">'
      + '<ref-clip ref="9" name="Anchor" lane="1" offset="0s" duration="1s">'
      + '<adjust-volume amount="-20dB"/></ref-clip></asset-clip>',
    ));
    expect(anchored.clips).toHaveLength(1);
    expect((anchored.clips[0] as unknown as Record<string, unknown>).volume).toBeUndefined();
    expect(anchored.unsupported).toHaveLength(1);
    expect(anchored.unsupported[0]).toContain('Asset-clip "Take 1"');
    expect(anchored.unsupported[0]).toContain('<ref-clip>');
    expect(anchored.unsupported[0]).toContain('adjust-volume');

    // The same for a compound carrier, which reads the same four fields.
    const carrier = parseFcpxml(doc(
      '<asset id="2" name="clip.mp4" src="file:///X:/media/clip.mp4" start="0s" duration="10s" hasVideo="1" hasAudio="1"/>'
      + '<media id="nest1" name="Nest"><sequence format="r1" duration="1s" tcStart="0s"><spine>'
      + '<gap name="Timeline" offset="0s" start="0s" duration="1s">'
      + '<asset-clip ref="2" name="Inner" lane="1" offset="0s" start="0s" duration="1s"/>'
      + '</gap></spine></sequence></media>',
      '<ref-clip ref="nest1" name="Anchor" lane="1" offset="0s" start="0s" duration="1s">'
      + '<audio-channel-source srcCh="1" outCh="L"><adjust-volume amount="-20dB"/>'
      + '</audio-channel-source></ref-clip>',
    ));
    expect(carrier.clips).toHaveLength(1);
    expect((carrier.clips[0] as unknown as Record<string, unknown>).volume).toBeUndefined();
    // Two notes here, not one: `audio-channel-source` is also an element this
    // importer reads for nothing, so the construct scan reports it as well. Both
    // statements are true and neither is a duplicate of the other.
    expect(carrier.unsupported.some(
      (n) => n.includes('Ref-clip "Anchor"') && n.includes('adjust-volume'),
    )).toBe(true);
  });
});
describe('a `file:` src keeps the root it names (#154)', () => {
  /**
   * Read through `parseFcpxml` rather than a private helper, because the value
   * that matters is the one the placement path later hands to `existsSync` and
   * `probeMedia`. A root that goes missing here is not a cosmetic difference: the
   * asset is reported OFFLINE and every clip on it is skipped.
   */
  function pathOf(src: string): string {
    const plan = parseFcpxml([
      '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE fcpxml>',
      '<fcpxml version="1.11"><resources>',
      '<format id="r1" frameDuration="1/30s" width="1920" height="1080"/>',
      `<asset id="2" name="a.mp4" src="${src}" start="0s" duration="10s" hasVideo="1"/>`,
      '</resources><library><event name="E"><project name="E"><spine>',
      '<asset-clip ref="2" name="A" lane="0" offset="0s" start="0s" duration="1s"/>',
      '</spine></project></event></library></fcpxml>',
    ].join(''));
    expect(plan.assets).toHaveLength(1);
    return plan.assets[0]!.path;
  }

  it.each([
    // A drive letter carries its own root, so the slash after the scheme is
    // punctuation and comes off. All three spellings name the same path.
    ['file:///C:/x', 'C:/x', 'drive, three slashes'],
    ['file://C:/x', 'C:/x', 'drive, two slashes'],
    ['file:/C:/x', 'C:/x', 'drive, one slash'],
    ['file:///D:/Media/clip.mp4', 'D:/Media/clip.mp4', 'drive, deeper path'],
    // A POSIX root is the scheme's slash, so it has to go back on. This is the
    // form Final Cut writes (`file:///Users/...`) and the one the old reader
    // turned into a relative path, so nothing placed.
    ['file:///tmp/x', '/tmp/x', 'POSIX root'],
    ['file:///Users/me/Movies/x.mov', '/Users/me/Movies/x.mov', 'macOS-shaped path'],
    ['file://tmp/x', '/tmp/x', 'POSIX, two slashes'],
    ['file:/tmp/x', '/tmp/x', 'POSIX, one slash'],
    // Percent-encoding is decoded first, so an escaped space is a real space and
    // the root decision is made on the decoded value.
    ['file:///tmp/my%20media/x.mp4', '/tmp/my media/x.mp4', 'encoded space, POSIX'],
    ['file:///C:/my%20media/x.mp4', 'C:/my media/x.mp4', 'encoded space, drive'],
    // A `#` is a fragment delimiter in a URL, so a literal one is escaped by the
    // writer and must come back as itself rather than truncating the path.
    ['file:///tmp/a%23b.mp4', '/tmp/a#b.mp4', 'encoded hash, POSIX'],
    ['file:///C:/a%23b.mp4', 'C:/a#b.mp4', 'encoded hash, drive'],
    // A `%` that is not a valid escape makes decodeURIComponent throw; the raw
    // value is kept rather than the asset being dropped, and the root still holds.
    ['file:///%ZZ', '/%ZZ', 'malformed percent escape'],
    // No scheme at all: already a path, so it must pass through untouched. This
    // is the regression a narrower fix would have introduced, since a leading
    // slash added to a bare `C:/x` is a different, wrong path.
    ['C:/x', 'C:/x', 'bare drive path, no scheme'],
    ['/tmp/x', '/tmp/x', 'bare POSIX path, no scheme'],
    // UNC has neither a drive nor a POSIX root. Stated, not glossed: this yields a
    // rooted path on the CURRENT drive, which is not the `\\server\share` named.
    // The writer has the same limitation (it collapses a leading `\\`), so a UNC
    // path does not survive our own round trip either. See the ledger entry.
    ['file://server/share/x.mp4', '/server/share/x.mp4', 'UNC, documented limitation'],
  ])('reads %s as %s (%s)', (src, expected) => {
    expect(pathOf(src as string)).toBe(expected as string);
  });

  it('skips an asset with an empty src rather than reading it as the filesystem root', () => {
    // The pre-existing `!src` guard drops the asset before any path work, which is
    // the right answer and is asserted here so it stays: turning `''` into `'/'`
    // would be far worse, since `existsSync('/')` is true and the asset would
    // probe as a real one.
    const plan = parseFcpxml([
      '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE fcpxml>',
      '<fcpxml version="1.11"><resources>',
      '<format id="r1" frameDuration="1/30s" width="1920" height="1080"/>',
      '<asset id="2" name="a.mp4" src="" start="0s" duration="10s" hasVideo="1"/>',
      '</resources><library><event name="E"><project name="E"><spine>',
      '<asset-clip ref="2" name="A" lane="0" offset="0s" start="0s" duration="1s"/>',
      '</spine></project></event></library></fcpxml>',
    ].join(''));
    expect(plan.assets).toEqual([]);
    expect(plan.clips).toEqual([]);
    expect(plan.unsupported).toEqual(['Asset-clip "A" references unknown resource 2.']);
  });

  it('round-trips a POSIX path through our own writer', () => {
    // exporter.ts's `fileUrl` collapses the leading slash, so `file:///tmp/x.mp4`
    // is what a POSIX path looks like on the wire. Before the fix the reader
    // handed back `tmp/x.mp4`, which failed `existsSync` and reported the asset
    // offline.
    const p = baseProject();
    p.media.push({
      id: 'posix', path: '/tmp/palmier/clip.mp4', filename: 'clip.mp4', type: 'video',
      duration: 60, fileSize: 1, addedAt: '', width: 1920, height: 1080,
    } as never);
    p.timeline.clips.push({
      id: 'c1', assetId: 'posix', trackId: 'v1', type: 'video', label: 'Shot',
      startFrame: 0, durationFrames: 90, inPoint: 0, outPoint: 90,
      x: 0, y: 0, width: 1920, height: 1080, rotation: 0, scaleX: 1, scaleY: 1,
      opacity: 1, anchorX: 0, anchorY: 0, volume: 1, muted: false,
    } as never);

    const xml = exportFcpxml(p);
    expect(xml).toContain('src="file:///tmp/palmier/clip.mp4"');
    const plan = parseFcpxml(xml);
    expect(plan.assets[0]!.path).toBe('/tmp/palmier/clip.mp4');
    expect(plan.clips).toHaveLength(1);
  });

  it('round-trips a Windows drive path through our own writer, unchanged', () => {
    // The other half of the contract: the fix must not disturb the shape that
    // already worked, which is every document this product has ever written.
    const p = baseProject();
    p.media.push({
      id: 'win', path: 'C:\\media\\clip.mp4', filename: 'clip.mp4', type: 'video',
      duration: 60, fileSize: 1, addedAt: '', width: 1920, height: 1080,
    } as never);
    p.timeline.clips.push({
      id: 'c1', assetId: 'win', trackId: 'v1', type: 'video', label: 'Shot',
      startFrame: 0, durationFrames: 90, inPoint: 0, outPoint: 90,
      x: 0, y: 0, width: 1920, height: 1080, rotation: 0, scaleX: 1, scaleY: 1,
      opacity: 1, anchorX: 0, anchorY: 0, volume: 1, muted: false,
    } as never);

    const xml = exportFcpxml(p);
    expect(xml).toContain('src="file:///C:/media/clip.mp4"');
    const plan = parseFcpxml(xml);
    expect(plan.assets[0]!.path).toBe('C:/media/clip.mp4');
    expect(plan.clips).toHaveLength(1);
  });
});

/**
 * A hostile id is neutralised at INGEST, and the rewrite is REPORTED.
 *
 * This is defence in depth behind the sink fix, not the fix: `exporter.ts` now
 * escapes every attribute value, so a hostile id cannot produce malformed XML
 * however it arrives. This stops it travelling through the model as a compound
 * reference — which is `AGENTS.md`'s "validate inputs" rule applied where the
 * value enters, not where it eventually leaves by.
 *
 * A sanitizer, not a silent drop: an id that had to be rewritten says so through
 * the existing `unsupported` channel, because a quiet rewrite is the same class of
 * defect as a quiet drop — the document said one thing and the imported project
 * would contain another with nothing to say so.
 */
describe('a hostile id is neutralised at ingest and reported (#154 security)', () => {
  /**
   * A producer that wants a hostile CHARACTER in an id has to escape it, because a
   * raw `"` would end the attribute. So the reachable forms are the escaped ones,
   * and — measured, not assumed — this importer's `attr()` does NOT XML-decode:
   * `id="a&amp;b"` arrives as the eight characters `a&amp;b`, and `id="a&quot;b"`
   * arrives as `a&quot;b`, never as a string containing a real `"`. The rewrite
   * below is therefore about characters that are legal to write escaped and
   * illegal in an id, which is exactly the set that can reach the plan.
   */
  const HOSTILE = 'a&amp;b';
  const CLEANED = 'a_amp_b';

  function doc(assetId: string, clipRef: string): string {
    return [
      '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE fcpxml>',
      '<fcpxml version="1.11"><resources>',
      '<format id="r1" frameDuration="1/30s" width="1920" height="1080"/>',
      `<asset id="${assetId}" name="clip.mp4" src="file:///X:/media/clip.mp4" start="0s"`
      + ' duration="10s" hasVideo="1"/>',
      '</resources><library><event name="E"><project name="E"><spine>',
      `<asset-clip ref="${clipRef}" name="Take 1" lane="0" offset="0s" start="0s" duration="1s"/>`,
      '</spine></project></event></library></fcpxml>',
    ].join('');
  }

  it('rewrites a hostile asset id and the ref pointing at it, keeping them paired', () => {
    // Both sides go through the SAME function, so a document whose id needed
    // cleaning still pairs; that is why the report fires twice, once per site.
    const plan = parseFcpxml(doc(HOSTILE, HOSTILE));

    expect(plan.assets.map((asset) => asset.ref)).toEqual([CLEANED]);
    expect(plan.clips).toHaveLength(1);
    expect(plan.clips[0]).toMatchObject({ kind: 'video', assetPath: 'X:/media/clip.mp4' });
    expect(plan.unsupported).toEqual([
      `Asset id "${HOSTILE}" is not a valid XML name; it is read as "${CLEANED}".`,
      `Asset-clip id "${HOSTILE}" is not a valid XML name; it is read as "${CLEANED}".`,
    ]);
  });

  it('rewrites every character that cannot appear in an id', () => {
    for (const [hostile, cleaned] of [
      ['a&amp;b', 'a_amp_b'],
      ['a b', 'a_b'],
      ['a:b', 'a_b'],
      ['a&quot;b', 'a_quot_b'],
    ] as const) {
      const plan = parseFcpxml(doc(hostile, hostile));
      expect(plan.assets.map((asset) => asset.ref), hostile).toEqual([cleaned]);
      expect(plan.clips, hostile).toHaveLength(1);
      expect(plan.unsupported, hostile).toEqual([
        `Asset id "${hostile}" is not a valid XML name; it is read as "${cleaned}".`,
        `Asset-clip id "${hostile}" is not a valid XML name; it is read as "${cleaned}".`,
      ]);
    }
  });

  it('leaves every id a real document uses byte-identical, with no note', () => {
    // Apple's DTD says `id ID #REQUIRED`, but Final Cut, Resolve and this repo's
    // own writer all emit NUMERIC resource ids, which a strict NCName would
    // reject. Being stricter than the format's own convention would rewrite every
    // legitimate document, so the leading character is deliberately unconstrained.
    for (const id of ['2', 'r1', 'nest1', 'ts1', 'palmier-asset-1', 'a.b_c-9']) {
      const plan = parseFcpxml(doc(id, id));
      expect(plan.assets.map((asset) => asset.ref), id).toEqual([id]);
      expect(plan.unsupported, id).toEqual([]);
    }
  });

  it('leaves the absent-id fallback exactly as it was', () => {
    // An asset with no id at all is still skipped, and the pre-existing
    // "unknown resource" note is still the only one, unchanged.
    const noId = parseFcpxml([
      '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE fcpxml>',
      '<fcpxml version="1.11"><resources>',
      '<format id="r1" frameDuration="1/30s" width="1920" height="1080"/>',
      '<asset name="clip.mp4" src="file:///X:/media/clip.mp4" start="0s" duration="10s" hasVideo="1"/>',
      '</resources><library><event name="E"><project name="E"><spine>',
      '<asset-clip ref="2" name="Take 1" lane="0" offset="0s" start="0s" duration="1s"/>',
      '</spine></project></event></library></fcpxml>',
    ].join(''));
    expect(noId.assets).toEqual([]);
    expect(noId.clips).toEqual([]);
    expect(noId.unsupported).toEqual(['Asset-clip "Take 1" references unknown resource 2.']);
  });

  it('rewrites a hostile <media> id and the carrier that references it', () => {
    const compound = [
      '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE fcpxml>',
      '<fcpxml version="1.11"><resources>',
      '<format id="r1" frameDuration="1/30s" width="1920" height="1080"/>',
      '<asset id="2" name="clip.mp4" src="file:///X:/media/clip.mp4" start="0s" duration="10s" hasVideo="1"/>',
      `<media id="${HOSTILE}" name="Nest"><sequence format="r1" duration="1s" tcStart="0s">`,
      '<spine><gap name="Timeline" offset="0s" start="0s" duration="1s">',
      '<asset-clip ref="2" name="Inner" lane="1" offset="0s" start="0s" duration="1s"/>',
      '</gap></spine></sequence></media>',
      '</resources><library><event name="E"><project name="E"><spine>',
      `<ref-clip ref="${HOSTILE}" name="Nest" lane="1" offset="0s" start="0s" duration="1s"/>`,
      '</spine></project></event></library></fcpxml>',
    ].join('');
    const plan = parseFcpxml(compound);
    // Both sides normalized identically, so the carrier still resolves.
    expect(plan.sequences?.map((sequence) => sequence.ref)).toEqual([CLEANED]);
    expect(plan.clips).toHaveLength(1);
    expect(plan.sequences?.[0]?.name).toBe('Nest');
    expect(plan.unsupported).toEqual([
      `Sequence resource id "${HOSTILE}" is not a valid XML name; it is read as "${CLEANED}".`,
      `Ref-clip id "${HOSTILE}" is not a valid XML name; it is read as "${CLEANED}".`,
    ]);
  });

  it('exercises the whole path: a hostile id in, well-formed XML out', () => {
    // The round trip the sink fix exists for. The imported clip's compound
    // reference is now clean, so re-exporting cannot produce a malformed document
    // even before escaping — and escaping means it cannot after either.
    const compound = [
      '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE fcpxml>',
      '<fcpxml version="1.11"><resources>',
      '<format id="r1" frameDuration="1/30s" width="1920" height="1080"/>',
      '<asset id="2" name="clip.mp4" src="file:///X:/media/clip.mp4" start="0s" duration="10s" hasVideo="1"/>',
      `<media id="${HOSTILE}" name="Nest"><sequence format="r1" duration="1s" tcStart="0s">`,
      '<spine><gap name="Timeline" offset="0s" start="0s" duration="1s">',
      '<asset-clip ref="2" name="Inner" lane="1" offset="0s" start="0s" duration="1s"/>',
      '</gap></spine></sequence></media>',
      '</resources><library><event name="E"><project name="E"><spine>',
      `<ref-clip ref="${HOSTILE}" name="Nest" lane="1" offset="0s" start="0s" duration="1s"/>`,
      '</spine></project></event></library></fcpxml>',
    ].join('');
    const plan = parseFcpxml(compound);

    const target = new EditorController();
    target.addMedia({
      id: 'imported', path: 'X:/media/clip.mp4', filename: 'clip.mp4', type: 'video',
      duration: 300, width: 1920, height: 1080, fileSize: 1, addedAt: '2026-01-01T00:00:00.000Z',
    });
    const result = applyFcpxmlPlan(target, plan, new Map([['X:/media/clip.mp4', 'imported']]),
      new Map([['X:/media/clip.mp4', { width: 1920, height: 1080 }]]));
    expect(result.placedClips).toBe(1);

    const xml = exportFcpxml(target.getProject());
    expect(xml).not.toContain('a&amp;b');
    // Every attribute value in the re-exported document is clean.
    for (const attr of xml.match(/[A-Za-z][\w:.-]*="([^"]*)"/g) ?? []) {
      const raw = attr.slice(attr.indexOf('"') + 1, -1);
      expect(raw, attr).not.toMatch(/[<>"']/);
      expect(raw, attr).not.toMatch(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9A-Fa-f]+);)/);
    }
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


