/**
 * Nested title/shape raster coverage (upstream issue #155, slice 2).
 *
 * Preview always composites the whole project from the root, so the
 * renderer must hand the compositor box-content bitmaps for title/shape
 * clips living inside nested timelines too — keyed by clip id, exactly like
 * main-timeline ones. Stubs OffscreenCanvas like the title/shape cache
 * tests do.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Clip, Project } from '../../shared/types/project';
import { createEmptyProject } from '../../shared/types/project';
import { visibleTitleRasters, clearTitleRasterCache } from './title-raster-cache';
import { visibleShapeRasters, clearShapeRasterCache } from './shape-raster-cache';

class FakeContext {
  font = '';
  fillStyle = '';
  strokeStyle = '';
  textAlign = 'center';
  textBaseline = 'middle';
  globalAlpha = 1;
  globalCompositeOperation = 'source-over';
  lineWidth = 0;
  lineJoin = 'miter';
  lineCap = 'butt';
  filter = 'none';
  save(): void {}
  restore(): void {}
  clearRect(): void {}
  fillRect(): void {}
  fillText(): void {}
  strokeText(): void {}
  drawImage(): void {}
  transform(): void {}
  beginPath(): void {}
  rect(): void {}
  ellipse(): void {}
  moveTo(): void {}
  lineTo(): void {}
  fill(): void {}
  stroke(): void {}
  measureText() {
    return { width: 40 };
  }
  getImageData(x: number, y: number, w: number, h: number) {
    return { data: new Uint8ClampedArray(Math.max(0, w) * Math.max(0, h) * 4) };
  }
}

class FakeOffscreenCanvas {
  width: number;
  height: number;
  readonly ctx = new FakeContext();
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
  getContext() {
    return this.ctx;
  }
}

beforeEach(() => {
  clearTitleRasterCache();
  clearShapeRasterCache();
  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

let seq = 0;
function clip(overrides: Partial<Clip>): Clip {
  seq += 1;
  return {
    id: `clip-${seq}`,
    assetId: 'v',
    type: 'video',
    trackId: 'v1',
    startFrame: 0,
    durationFrames: 90,
    inPoint: 0,
    outPoint: 90,
    x: 10,
    y: 10,
    width: 100,
    height: 60,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    opacity: 1,
    anchorX: 0,
    anchorY: 0,
    volume: 1,
    muted: false,
    ...overrides,
  };
}

function projectWithNest(): Project {
  const project = createEmptyProject();
  project.timeline.clips = [
    clip({ id: 'main-title', assetId: '__title__', type: 'title', text: 'Main', startFrame: 0, durationFrames: 90 }),
    clip({
      id: 'nest', assetId: '__compound__', type: 'compound', compoundTimelineId: 'n1',
      startFrame: 0, durationFrames: 90, inPoint: 0, outPoint: 90, label: 'Nest',
    }),
  ];
  project.timelines = {
    n1: {
      tracks: project.timeline.tracks,
      playheadFrame: 0,
      name: 'Nest',
      clips: [
        clip({
          id: 'nested-title', assetId: '__title__', type: 'title', text: 'Nested',
          startFrame: 0, durationFrames: 90,
        }),
        clip({
          id: 'nested-shape', assetId: '__shape__', type: 'shape', shapeKind: 'rect',
          shapeStrokeColor: '#ffffff', shapeStrokeWidth: 4,
          startFrame: 0, durationFrames: 90,
        }),
      ],
    },
  };
  return project;
}

describe('nested raster coverage', () => {
  it('rasterizes nested titles alongside main-timeline ones', () => {
    const rasters = visibleTitleRasters(projectWithNest(), 10);
    expect(rasters.map((raster) => raster.clipId).sort()).toEqual(['main-title', 'nested-title']);
  });

  it('rasterizes nested shapes alongside main-timeline ones', () => {
    const project = projectWithNest();
    project.timeline.clips.push(
      clip({
        id: 'main-shape', assetId: '__shape__', type: 'shape', shapeKind: 'rect',
        shapeStrokeColor: '#ffffff', shapeStrokeWidth: 4,
        startFrame: 0, durationFrames: 90,
      }),
    );
    const rasters = visibleShapeRasters(project, 10);
    expect(rasters.map((raster) => raster.clipId).sort()).toEqual(['main-shape', 'nested-shape']);
  });

  it('skips nested clips on hidden tracks', () => {
    const project = projectWithNest();
    project.timelines!.n1.tracks = project.timelines!.n1.tracks.map((track) =>
      (track.id === 'v1' ? { ...track, visible: false } : track));
    expect(visibleTitleRasters(project, 10).map((raster) => raster.clipId)).toEqual(['main-title']);
    expect(visibleShapeRasters(project, 10)).toEqual([]);
  });

  it('keeps the main-timeline frame filter exact', () => {
    const project = projectWithNest();
    // Frame 200: the main title's window [0, 90) excludes it; the nested
    // title has no root-frame mapping, so it still rasterizes for the
    // compositor's resolved lookup.
    expect(visibleTitleRasters(project, 200).map((raster) => raster.clipId)).toEqual(['nested-title']);
  });
});
