/**
 * Export-reporting and upstream element-contract coverage for FCPXML #154.
 * The report may describe omitted local properties, but it must not alter the
 * XML body; conform and still-image elements must also round-trip cleanly.
 */
import { describe, expect, it } from 'vitest';
import type { Project } from '../types/project';
import { EditorController } from '../editor/controller';
import { applyFcpxmlPlan } from './apply';
import { exportFcpxml, exportFcpxmlWithReport } from './exporter';
import { parseFcpxml } from './importer';

const VIDEO_PATH = 'X:/media/clip.mp4';
const IMAGE_PATH = 'X:/media/still.png';

function baseProject(): Project {
  return {
    version: 2,
    name: 'Report Fixture',
    settings: { width: 1920, height: 1080, fps: 30, sampleRate: 48000, backgroundColor: '#000000' },
    media: [
      {
        id: 'v', path: VIDEO_PATH, filename: 'clip.mp4', type: 'video', duration: 60,
        width: 1920, height: 1080, fileSize: 1, addedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'i', path: IMAGE_PATH, filename: 'still.png', type: 'image', duration: 0,
        width: 1920, height: 1080, fileSize: 1, addedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    timeline: {
      tracks: [{ id: 'v1', name: 'Video 1', type: 'video', locked: false, visible: true, syncLocked: true, order: 0 }],
      clips: [],
      playheadFrame: 0,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as unknown as Project;
}

function baseClip(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c1', assetId: 'v', label: 'Clip', trackId: 'v1', type: 'video' as const,
    startFrame: 0, durationFrames: 60, inPoint: 0, outPoint: 60,
    x: 0, y: 0, width: 1920, height: 1080, rotation: 0, scaleX: 1, scaleY: 1,
    opacity: 1, anchorX: 0, anchorY: 0, volume: 1, muted: false,
    ...overrides,
  };
}

function withClips(clips: Array<Record<string, unknown>>): Project {
  const project = baseProject();
  project.timeline.clips = clips.map((clip) => clip as unknown as Project['timeline']['clips'][number]);
  return project;
}

describe('FCPXML export omission reporting (#154)', () => {
  it('names each effective omitted property without changing the XML body', () => {
    const project = withClips([baseClip({
      id: 'omitted',
      brightness: 0.2,
      blurRadius: 2,
      blendMode: 'multiply',
      fadeInFrames: 12,
      edgeSoftness: 0.3,
    })]);

    const report = exportFcpxmlWithReport(project);

    expect(report.unsupported).toEqual([
      'Clip "omitted" carries color grade; FCPXML does not represent it.',
      'Clip "omitted" carries effects; FCPXML does not represent them.',
      'Clip "omitted" carries layer blend mode; FCPXML does not represent it.',
      'Clip "omitted" carries fades; FCPXML does not represent them.',
      'Clip "omitted" carries edge softness; FCPXML does not represent it.',
    ]);
    expect(report.skippedClips).toBe(0);
    expect(report.exportedClips).toBe(1);
    expect(exportFcpxml(project)).toBe(report.xml);

    const plan = parseFcpxml(report.xml);
    expect(plan.unsupported).toEqual([]);
    expect(plan.clips).toHaveLength(1);
    expect(plan.clips[0]?.kind).toBe('video');
  });

  it('does not report explicitly present but effective default values', () => {
    const project = withClips([baseClip({
      brightness: 0, contrast: 1, saturation: 1, hueRotation: 0, exposure: 0,
      temperature: 6500, tint: 0, vibrance: 0, highlights: 0, shadows: 0,
      blacks: 0, whites: 0, invertColors: false,
      curves: { master: [], red: [], green: [], blue: [] },
      wheels: {
        lift: { x: 0, y: 0, m: 0 },
        gamma: { x: 0, y: 0, m: 1 },
        gain: { x: 0, y: 0, m: 1 },
      },
      hueCurves: { hueVsHue: [], hueVsSat: [], hueVsLum: [] },
      blurRadius: 0,
      vignette: { amount: 0, midpoint: 0.5, roundness: 0, feather: 0.5 },
      grain: { amount: 0, size: 1.5 },
      glow: { intensity: 0, radius: 20, threshold: 0.6, warmth: 0 },
      blendMode: 'normal',
      fadeInFrames: 0, fadeOutFrames: 0,
      edgeRounding: 0, edgeSoftness: 0,
    })]);

    expect(exportFcpxmlWithReport(project).unsupported).toEqual([]);
  });

  it('reports omissions without making the imported project unsupported', () => {
    const source = withClips([baseClip({ id: 'grade-only', brightness: 0.25 })]);
    const report = exportFcpxmlWithReport(source);
    const plan = parseFcpxml(report.xml);

    const target = new EditorController();
    target.addMedia({
      id: 'imported', path: VIDEO_PATH, filename: 'clip.mp4', type: 'video',
      duration: 60, width: 1920, height: 1080, fileSize: 1,
      addedAt: new Date().toISOString(),
    });
    const result = applyFcpxmlPlan(
      target,
      plan,
      new Map([[VIDEO_PATH, 'imported']]),
      new Map([[VIDEO_PATH, { width: 1920, height: 1080 }]]),
    );

    expect(result.placedClips).toBe(1);
    expect(exportFcpxmlWithReport(target.getProject()).unsupported).toEqual([]);
  });
});

describe('FCPXML conform and still-image contracts (#154)', () => {
  it('emits upstream conform hints on visual and title clips', () => {
    const project = withClips([
      baseClip({ id: 'video-clip', label: 'Video' }),
      baseClip({
        id: 'image-clip', assetId: 'i', label: 'Image', type: 'image',
        startFrame: 60,
      }),
      {
        ...baseClip({ id: 'title-clip', type: 'title', assetId: '__title__', startFrame: 120 }),
        text: 'Title',
      },
    ]);

    const xml = exportFcpxml(project);
    expect(xml.match(/<adjust-conform type="fit"\/>/g)).toHaveLength(3);
    expect(xml).toMatch(/<video name="Image"[^>]*><adjust-conform type="fit"\/><\/video>/);
    expect(xml).toMatch(/<title name="Title"[^>]*>[\s\S]*<adjust-conform type="fit"\/><\/title>/);

    const plan = parseFcpxml(xml);
    expect(plan.unsupported).toEqual([]);
    expect(plan.clips.filter((clip) => clip.kind === 'video')).toHaveLength(2);
    expect(plan.clips.filter((clip) => clip.kind === 'title')).toHaveLength(1);
  });
});
