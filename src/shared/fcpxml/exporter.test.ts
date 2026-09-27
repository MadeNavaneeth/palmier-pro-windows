/**
 * Coverage for the FCPXML exporter (#154): resource dedupe, the spine/lanes
 * mapping contract, decimal-second timing, title styling, and XML escaping.
 * The importer (next phase) must parse exactly what these tests pin.
 */
import { describe, it, expect } from 'vitest';
import type { Project, Timeline } from '../types/project';
import { MAX_COMPOUND_DEPTH } from '../editor/compound';
import { exportFcpxml, exportFcpxmlWithReport } from './exporter';


function baseProject(): Project {
  const project = {
    version: 2,
    name: 'My Film',
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
  return project;
}

function addMedia(project: Project, id: string, path: string, type: 'video' | 'audio', audioCodec?: string) {
  project.media.push({
    id, path, filename: path.split(/[\\/]/).pop()!, type, duration: 60,
    fileSize: 1, addedAt: '2026-08-26T00:00:00.000Z',
    ...(type === 'video' ? { width: 1920, height: 1080 } : {}),
    ...(audioCodec ? { audioCodec } : {}),
  });
}

function addClip(project: Project, overrides: Record<string, unknown>) {
  project.timeline.clips.push({
    id: `c${project.timeline.clips.length + 1}`,
    assetId: 'a',
    label: '',
    trackId: 'v1',
    type: 'video',
    startFrame: 0,
    durationFrames: 90,
    inPoint: 15,
    outPoint: 105,
    x: 0, y: 0, width: 1920, height: 1080,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    anchorX: 0, anchorY: 0, volume: 1, muted: false,
    ...overrides,
  });
}

function clipFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'clip',
    assetId: 'a',
    label: 'Clip',
    trackId: 'v1',
    type: 'video',
    startFrame: 0,
    durationFrames: 60,
    inPoint: 0,
    outPoint: 60,
    x: 0, y: 0, width: 1920, height: 1080,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    anchorX: 0, anchorY: 0, volume: 1, muted: false,
    ...overrides,
  };
}

function compoundFixture(id: string, timelineId: string, overrides: Record<string, unknown> = {}) {
  return {
    ...clipFixture({
      id,
      assetId: '__compound__',
      type: 'compound',
      label: timelineId,
      compoundTimelineId: timelineId,
      ...overrides,
    }),
  };
}

function timelineFixture(name: string, clips: Array<ReturnType<typeof clipFixture>>): Timeline {
  return {
    name,
    tracks: [
      { id: 'v1', name: 'Video 1', type: 'video', locked: false, visible: true, syncLocked: true, order: 0 },
    ],
    clips: clips as Timeline['clips'],
    playheadFrame: 0,
  };
}

function addRootCompound(project: Project, id: string, timelineId: string, overrides: Record<string, unknown> = {}) {
  project.timeline.clips.push(compoundFixture(id, timelineId, overrides) as Project['timeline']['clips'][number]);
}

function addNestedCompound(timeline: Timeline, id: string, timelineId: string, overrides: Record<string, unknown> = {}) {
  timeline.clips.push(compoundFixture(id, timelineId, overrides) as Timeline['clips'][number]);
}


describe('exportFcpxml (#154)', () => {
  it('emits one asset per unique path with file URLs and stream flags', () => {
    const p = baseProject();
    addMedia(p, 'a', 'C:\\media\\main.mp4', 'video', 'aac');
    addMedia(p, 'b', 'C:/media/main.mp4', 'video', 'aac'); // same file, other slashes

    addClip(p, { assetId: 'a', text: undefined as unknown as never, type: 'video' });
    addClip(p, { assetId: 'b', startFrame: 120 });

    const xml = exportFcpxml(p);

    expect(xml.match(/<asset /g)).toHaveLength(1); // deduped across separators
    expect(xml).toContain('src="file:///C:/media/main.mp4"');
    expect(xml).toContain('hasVideo="1" hasAudio="1"');
    expect(xml).toContain('<format id="r1" frameDuration="0.033333s" width="1920" height="1080"/>');
  });

  it('puts the lowest video track on the spine and upper tracks on dense lanes', () => {
    const p = baseProject();
    addMedia(p, 'a', 'X:/clip.mp4', 'video', 'aac');
    addClip(p, { trackId: 'v1', startFrame: 30 });   // spine
    addClip(p, { trackId: 'v2', startFrame: 30 });   // first upper lane

    const xml = exportFcpxml(p);
    const tags = xml.match(/<asset-clip[^>]*>/g) ?? [];
    expect(tags).toHaveLength(2);
    expect(tags[0]).not.toContain('lane=');
    expect(tags[0]).toContain('offset="1.000000s"');
    expect(tags[1]).toContain('lane="1"');
  });

  it('maps audio to negative lanes with dialogue role', () => {
    const p = baseProject();
    addMedia(p, 'm', 'X:/music.wav', 'audio');
    addClip(p, { assetId: 'm', type: 'audio', trackId: 'a1', startFrame: 10 });

    const xml = exportFcpxml(p);
    expect(xml).toContain('lane="-1"');
    expect(xml).toContain('audioRole="dialogue"');
  });

  it('uses decimal seconds for offset/duration/start', () => {
    const p = baseProject();
    addMedia(p, 'a', 'X:/clip.mp4', 'video', 'aac');
    addClip(p, { startFrame: 45, durationFrames: 90, inPoint: 15, outPoint: 105 });

    const xml = exportFcpxml(p);
    expect(xml).toContain('offset="1.500000s"');
    expect(xml).toContain('duration="3.000000s"');
    expect(xml).toContain('start="0.500000s"');
  });

  it('exports titles with escaped text and per-clip style defs', () => {
    const p = baseProject();
    p.timeline.clips.push({
      id: 't1', assetId: '__title__', type: 'title', trackId: 'v1',
      label: 'Title', text: 'A & B <C>\nline two', titleSizeRatio: 0.1,
      titleColor: '#ffcc00', titleFontFamily: 'Georgia', titleAlign: 'left',
      titleFontCase: 'upper', titleBackgroundColor: '#00000080',
      titleBackgroundPadding: 8, titleLineSpacing: 0, titleBlurRadius: 0,
      startFrame: 0, durationFrames: 60, inPoint: 0, outPoint: 60,
      x: 0, y: 0, width: 800, height: 200, rotation: 0, scaleX: 1, scaleY: 1,
      opacity: 1, anchorX: 0, anchorY: 0, volume: 1, muted: false,
    } as Project['timeline']['clips'][number]);

    const xml = exportFcpxml(p);
    expect(xml).toContain('<text-style ref="ts1">A &amp; B &lt;C&gt;');
    expect(xml).toContain('LINE TWO'); // fontCase applies (#330)
    expect(xml).toContain('fontSize="108"'); // 0.1 × 1080
    expect(xml).toContain('fontColor="#FFCC00"');
    expect(xml).toContain('font="Georgia"');
    expect(xml).toContain('alignment="LEFT"');
    expect(xml).toContain('</text-style-def></fcpxml>');
  });

  it('writes a source timecode child when the asset carries one (#154)', () => {
    const p = baseProject();
    addMedia(p, 'a', 'X:/clip.mp4', 'video', 'aac');
    p.media[0].startTimecode = '01:00:00:00';
    addClip(p, { assetId: 'a' });

    const xml = exportFcpxml(p);

    expect(xml).toContain('<timecode start="3600.000000s" duration="60.000000s" format="r1"/>');
    expect(xml).toMatch(/<asset [^>]*>\s*<timecode/);
    expect(xml).toContain('</asset>');
  });

  it('omits the timecode child for drop-frame strings rather than guessing', () => {
    const p = baseProject();
    addMedia(p, 'a', 'X:/clip.mp4', 'video', 'aac');
    p.media[0].startTimecode = '01:00:00;00';
    addClip(p, { assetId: 'a' });

    const xml = exportFcpxml(p);

    expect(xml).not.toContain('<timecode');
  });

  it('throws when there is nothing representable', () => {
    const p = baseProject();
    expect(() => exportFcpxml(p)).toThrow();
  });
});

describe('compound ref-clip export (#154/#289)', () => {
  it('emits a nested sequence resource and parent ref-clip with the source window honored', () => {
    const p = baseProject();
    addMedia(p, 'a', 'X:/nested.mp4', 'video', 'aac');
    p.timelines = {
      intro: timelineFixture('Intro', [clipFixture({ id: 'inner-video' })]),
    };
    addRootCompound(p, 'compound-root', 'intro', {
      label: 'Intro carrier',
      startFrame: 30,
      durationFrames: 60,
      inPoint: 10,
      outPoint: 70,
    });

    const report = exportFcpxmlWithReport(p);

    expect(report.unsupported).toEqual([]);
    expect(report.skippedClips).toBe(0);
    expect(report.exportedClips).toBe(1);
    expect(report.xml).toContain('<media id="nest1" name="Intro">');
    expect(report.xml).toContain(
      '<sequence format="r1" duration="2.000000s" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">',
    );
    expect(report.xml).toMatch(
      /<ref-clip ref="nest1" name="Intro" lane="2" offset="1\.000000s" start="0\.333333s" duration="1\.666667s" enabled="1" srcEnable="video">/,
    );
    expect(report.xml).toContain(
      '<gap name="Timeline" offset="0s" start="0s" duration="2.000000s">',
    );
    expect(report.xml).toMatch(/<asset-clip ref="2" name="Clip" lane="1"/);
  });

  it('recurses nested compounds and emits both sequence resources in preorder', () => {
    const p = baseProject();
    addMedia(p, 'a', 'X:/deep.mp4', 'video', 'aac');
    const deep = timelineFixture('Deep', [clipFixture({ id: 'deep-video' })]);
    const child = timelineFixture('Child', []);
    addNestedCompound(child, 'child-compound', 'deep', {
      durationFrames: 60,
      inPoint: 0,
      outPoint: 60,
    });
    p.timelines = { child, deep };
    addRootCompound(p, 'root-compound', 'child', {
      durationFrames: 60,
      inPoint: 0,
      outPoint: 60,
    });

    const report = exportFcpxmlWithReport(p);

    expect(report.unsupported).toEqual([]);
    expect(report.xml).toContain('<media id="nest1" name="Child">');
    expect(report.xml).toContain('<media id="nest2" name="Deep">');
    expect(report.xml).toMatch(/<ref-clip ref="nest1"/);
    expect(report.xml).toMatch(/<ref-clip ref="nest2"/);
    expect(report.xml).toContain('<sequence format="r1" duration="2.000000s"');
    expect(report.xml).toMatch(/<gap name="Timeline"[\s\S]*<ref-clip ref="nest2"/);
  });

  it('reports depth overflow without emitting a partial sequence', () => {
    const p = baseProject();
    addMedia(p, 'a', 'X:/deep.mp4', 'video', 'aac');
    p.timelines = {};
    for (let index = 0; index <= MAX_COMPOUND_DEPTH; index += 1) {
      const timelineId = `level-${index}`;
      p.timelines[timelineId] = timelineFixture(timelineId, []);
      if (index < MAX_COMPOUND_DEPTH) {
        addNestedCompound(p.timelines[timelineId], `compound-${index}`, `level-${index + 1}`, {
          durationFrames: 60,
          inPoint: 0,
          outPoint: 60,
        });
      } else {
        p.timelines[timelineId].clips.push(
          clipFixture({ id: 'leaf-video' }) as Timeline['clips'][number],
        );
      }
    }
    addRootCompound(p, 'root-compound', 'level-0', {
      durationFrames: 60,
      inPoint: 0,
      outPoint: 60,
    });

    const report = exportFcpxmlWithReport(p);

    expect(report.unsupported.some((note) => /maximum.*depth|depth/i.test(note))).toBe(true);
    expect(report.skippedClips).toBe(1);
    expect(report.xml).not.toContain('<media id="nest');
    expect(report.xml).not.toContain('<ref-clip');
  });

  it('reports cycles without emitting a partial sequence or looping', () => {
    const p = baseProject();
    p.timelines = {
      a: timelineFixture('A', []),
      b: timelineFixture('B', []),
    };
    addNestedCompound(p.timelines.a, 'a-to-b', 'b', {
      durationFrames: 60,
      inPoint: 0,
      outPoint: 60,
    });
    addNestedCompound(p.timelines.b, 'b-to-a', 'a', {
      durationFrames: 60,
      inPoint: 0,
      outPoint: 60,
    });
    addRootCompound(p, 'root-compound', 'a', {
      durationFrames: 60,
      inPoint: 0,
      outPoint: 60,
    });

    const report = exportFcpxmlWithReport(p);

    expect(report.unsupported.some((note) => /cycle/i.test(note))).toBe(true);
    expect(report.skippedClips).toBe(1);
    expect(report.xml).not.toContain('<media id="nest');
    expect(report.xml).not.toContain('<ref-clip');
  });

  it('keeps sequence IDs separate from format and asset IDs', () => {
    const p = baseProject();
    addMedia(p, 'a', 'X:/nested.mp4', 'video', 'aac');
    p.timelines = {
      intro: timelineFixture('Intro', [clipFixture({ id: 'inner-video' })]),
    };
    addRootCompound(p, 'root-compound', 'intro', {
      durationFrames: 60,
      inPoint: 0,
      outPoint: 60,
    });

    const xml = exportFcpxml(p);
    const ids = [...xml.matchAll(/<(?:format|asset|media) id="([^"]+)"/g)].map((match) => match[1]);

    expect(ids).toEqual(expect.arrayContaining(['r1', '2', 'nest1']));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('exports ordinary clips and titles alongside a compound carrier', () => {
    const p = baseProject();
    addMedia(p, 'a', 'X:/ordinary.mp4', 'video', 'aac');
    p.timelines = {
      intro: timelineFixture('Intro', [clipFixture({ id: 'inner-video' })]),
    };
    addClip(p, { id: 'ordinary', assetId: 'a', startFrame: 0, durationFrames: 30, inPoint: 0, outPoint: 30 });
    p.timeline.clips.push(clipFixture({
      id: 'title',
      assetId: '__title__',
      type: 'title',
      text: 'Title',
      startFrame: 30,
      durationFrames: 30,
      inPoint: 0,
      outPoint: 30,
    }) as Project['timeline']['clips'][number]);
    addRootCompound(p, 'root-compound', 'intro', {
      startFrame: 60,
      durationFrames: 60,
      inPoint: 0,
      outPoint: 60,
    });

    const report = exportFcpxmlWithReport(p);

    expect(report.exportedClips).toBe(3);
    expect(report.xml).toMatch(/<asset-clip ref="2" name="Clip"/);
    expect(report.xml).toContain('<title ref="ts1" name="Title"');
    expect(report.xml).toContain('<media id="nest1" name="Intro">');
    expect(report.xml).toMatch(/<ref-clip ref="nest1"/);
  });

  it('keeps a no-compound document byte-identical to the legacy exporter', () => {
    const p = baseProject();
    addMedia(p, 'a', 'X:/clip.mp4', 'video', 'aac');
    addClip(p, { durationFrames: 60, inPoint: 0, outPoint: 60 });

    expect(exportFcpxml(p)).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE fcpxml>'
      + '<fcpxml version="1.11"><resources>'
      + '<format id="r1" frameDuration="0.033333s" width="1920" height="1080"/>'
      + '<asset id="2" name="clip.mp4" src="file:///X:/clip.mp4" start="0s" duration="60.000000s"'
      + ' hasVideo="1" hasAudio="1" format="r1"/></resources>'
      + '<library><event name="My Film"><project name="My Film"><spine>'
      + '<asset-clip name="Clip" offset="0.000000s" duration="2.000000s" start="0.000000s" ref="2">'
      + '<adjust-conform type="fit"/></asset-clip></spine></project></event></library></fcpxml>',
    );
  });
});

/**
 * Every attribute value in the emitted FCPXML must be escaped, whatever produced
 * it. This is the sink `js/incomplete-html-attribute-sanitization` flagged (the
 * rule's "HTML attribute" wording is generic JS phrasing; the attribute definition
 * it names is FCPXML's), and it is a correctness fix as much as a security one: a
 * value carrying a raw `"` or `<` produces a document that is not well-formed XML
 * at all, so the exporter can emit something no consumer can read.
 *
 * The fix belongs at the SINK rather than at each producer, because an attribute
 * value can arrive from a `.vproj` on disk, from the Agent, or from an import, not
 * only from a field we happen to validate today.
 */
describe('every exported attribute value is escaped (#154 security)', () => {
  /**
   * Every attribute value in the document whose RAW text carries a character that
   * cannot appear unescaped there: `<`, `>`, or `"`, or a `&` that does not begin
   * an entity. A dependency-free structural check, so it does not depend on this
   * repo's own parser being lenient enough to notice.
   */
  function unescapedAttributeValues(xml: string): string[] {
    const found: string[] = [];
    const tag = /<[A-Za-z][^>]*>/g;
    let match: RegExpExecArray | null;
    while ((match = tag.exec(xml)) !== null) {
      const attrs = match[0].match(/[A-Za-z][\w:.-]*="([^"]*)"/g) ?? [];
      for (const attr of attrs) {
        const raw = attr.slice(attr.indexOf('"') + 1, -1);
        if (raw.includes('<') || raw.includes('>') || raw.includes('"')) {
          found.push(`${match[0].slice(0, 40)} -> ${attr}`);
        } else if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9A-Fa-f]+);)/.test(raw)) {
          found.push(`${match[0].slice(0, 40)} -> ${attr} (bare &)`);
        }
      }
    }
    return found;
  }

  /** A project with one media clip, optionally carrying an extra title. */
  function withTitle(titleColor?: string): Project {
    const p = baseProject();
    addMedia(p, 'a', 'X:/clip.mp4', 'video', 'aac');
    addClip(p, { durationFrames: 60, inPoint: 0, outPoint: 60 });
    p.timeline.clips.push({
      ...clipFixture({
        id: 'title', assetId: '__title__', type: 'title', text: 'Cap', label: 'Cap',
        startFrame: 0, durationFrames: 30, inPoint: 0, outPoint: 30,
        ...(titleColor === undefined ? {} : { titleColor }),
      }),
    } as Project['timeline']['clips'][number]);
    return p;
  }

  it('escapes a title colour carrying a double quote', () => {
    const hostile = '"><inject a="1';
    const xml = exportFcpxml(withTitle(hostile));

    // The defect, before the fix: the value closed the attribute, so `><inject a="1`
    // left the tag as element content and an <inject> element entered the document.
    //   fontColor=""><INJECT A="1" alignment="CENTER"/>
    // After: one attribute, one value, and nothing that can end a tag.
    //   fontColor="&quot;&gt;&lt;INJECT A=&quot;1" alignment="CENTER"/>
    // (`titleColor` is upper-cased by the emitter, so the value reads INJECT.)
    expect(unescapedAttributeValues(xml)).toEqual([]);
    expect(xml).not.toContain('<INJECT');
    expect(xml).not.toContain('<inject');
    expect(xml).toContain('fontColor="&quot;&gt;&lt;INJECT A=&quot;1"');
  });

  it('escapes a title colour carrying <, > or &', () => {
    // The exact escaped form per character. Before the fix a raw `<` opened a tag
    // inside the attribute and a raw `&` was not the start of an entity, so both
    // were malformed XML; `titleColor` is upper-cased by the emitter.
    for (const [hostile, escaped] of [
      ['a<b', 'A&lt;B'],
      ['a>b', 'A&gt;B'],
      ['a&b', 'A&amp;B'],
      ['<script>x</script>', '&lt;SCRIPT&gt;X&lt;/SCRIPT&gt;'],
    ] as const) {
      const xml = exportFcpxml(withTitle(hostile));

      expect(unescapedAttributeValues(xml), hostile).toEqual([]);
      expect(xml, hostile).toContain(`fontColor="${escaped}"`);
      expect(xml, hostile).not.toContain('<SCRIPT>');
    }
  });

  it('escapes the ids and refs on the compound path, which are attribute values too', () => {
    // These are internally generated (`nest<N>`, `ts<N>`, a resource number), so
    // they are not the reachable hole — but an unescaped interpolation is a latent
    // one, and the fix is at the sink. Asserted on the emitted form so a future
    // refactor that emits a real id cannot reopen it silently.
    const p = baseProject();
    addMedia(p, 'a', 'X:/clip.mp4', 'video', 'aac');
    addClip(p, { durationFrames: 60, inPoint: 0, outPoint: 60 });
    p.timeline.clips.push({
      ...clipFixture({
        id: 'title', assetId: '__title__', type: 'title', text: 'Cap', label: 'Cap',
        startFrame: 0, durationFrames: 30, inPoint: 0, outPoint: 30,
      }),
    } as Project['timeline']['clips'][number]);
    p.timelines = { 'nest-1': timelineFixture('nest-1', [clipFixture()]) } as Project['timelines'];
    addRootCompound(p, 'carrier', 'nest-1');

    const xml = exportFcpxml(p);

    expect(unescapedAttributeValues(xml)).toEqual([]);
    expect(xml).toContain('<media id="nest1"');
    expect(xml).toContain('<ref-clip ref="nest1"');
    expect(xml).toContain('<text-style-def id="ts1"');
    expect(xml).toContain('<title ref="ts1"');
  });

  it('leaves a project with safe ids byte-identical to the pre-fix export', () => {
    // The fix must be provably inert on the common path. This fixture exercises
    // the asset, title, compound-media and ref-clip attribute paths at once, and
    // the expectation is the exporter's output VERBATIM, captured before the fix,
    // so a single changed character anywhere in the emitter fails here.
    const p = baseProject();
    addMedia(p, 'a', 'X:/clip.mp4', 'video', 'aac');
    addClip(p, { durationFrames: 60, inPoint: 0, outPoint: 60 });
    p.timeline.clips.push({
      ...clipFixture({
        id: 'title', assetId: '__title__', type: 'title', text: 'Cap', label: 'Cap',
        startFrame: 0, durationFrames: 30, inPoint: 0, outPoint: 30,
        titleColor: '#ffcc00', titleFontFamily: 'Georgia', titleAlign: 'left',
      }),
    } as Project['timeline']['clips'][number]);
    p.timelines = { 'nest-1': timelineFixture('nest-1', [clipFixture()]) } as Project['timelines'];
    addRootCompound(p, 'carrier', 'nest-1');

    const xml = exportFcpxml(p);

    expect(unescapedAttributeValues(xml)).toEqual([]);
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE fcpxml>'
      + '<fcpxml version="1.11"><resources>'
      + '<format id="r1" frameDuration="0.033333s" width="1920" height="1080"/>'
      + '<asset id="2" name="clip.mp4" src="file:///X:/clip.mp4" start="0s" duration="60.000000s"'
      + ' hasVideo="1" hasAudio="1" format="r1"/>'
      + '<media id="nest1" name="nest-1"><sequence format="r1" duration="2.000000s" tcStart="0s"'
      + ' tcFormat="NDF" audioLayout="stereo" audioRate="48k"><spine>'
      + '<gap name="Timeline" offset="0s" start="0s" duration="2.000000s">'
      + '<asset-clip ref="2" name="Clip" lane="1" offset="0.000000s" start="0.000000s"'
      + ' duration="2.000000s" enabled="1"><adjust-conform type="fit"/></asset-clip>'
      + '</gap></spine></sequence></media></resources>'
      + '<library><event name="My Film"><project name="My Film"><spine>'
      + '<asset-clip ref="2" name="Clip" lane="2" offset="0.000000s" start="0.000000s"'
      + ' duration="2.000000s" enabled="1"><adjust-conform type="fit"/></asset-clip>'
      + '<title ref="ts1" name="Cap" lane="2" offset="0.000000s" start="0.000000s"'
      + ' duration="1.000000s" enabled="1"><text><text-style ref="ts1">Cap</text-style></text>'
      + '<adjust-conform type="fit"/></title>'
      + '<ref-clip ref="nest1" name="nest-1" lane="2" offset="0.000000s" start="0.000000s"'
      + ' duration="2.000000s" enabled="1" srcEnable="video"><adjust-conform type="fit"/></ref-clip>'
      + '</spine></project></event></library>'
      + '<text-style-def id="ts1"><text-style font="Georgia" fontSize="97" fontColor="#FFCC00"'
      + ' alignment="LEFT"/></text-style-def></fcpxml>',
    );
  });
});


