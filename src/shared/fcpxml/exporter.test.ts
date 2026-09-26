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


