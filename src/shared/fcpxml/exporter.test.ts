/**
 * Coverage for the FCPXML exporter (#154): resource dedupe, the spine/lanes
 * mapping contract, decimal-second timing, title styling, and XML escaping.
 * The importer (next phase) must parse exactly what these tests pin.
 */
import { describe, it, expect } from 'vitest';
import type { Project } from '../types/project';
import { exportFcpxml } from './exporter';

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
    expect(xml).toContain('fontSize="108"'); // 0.1 Ã— 1080
    expect(xml).toContain('fontColor="#FFCC00"');
    expect(xml).toContain('font="Georgia"');
    expect(xml).toContain('alignment="LEFT"');
    expect(xml).toContain('</text-style-def></fcpxml>');
  });

  it('throws when there is nothing representable', () => {
    const p = baseProject();
    expect(() => exportFcpxml(p)).toThrow();
  });
});


