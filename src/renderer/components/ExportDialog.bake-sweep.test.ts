/**
 * The delivery panel's title/shape bake sweep across compound nesting.
 *
 * FFmpeg has no filter for a vector shape or an advanced title, so the panel
 * rasterizes both to PNG and hands them to the graph, which looks each one up
 * by the clip id of the RESOLVED timeline (`main/media/export-args.ts:307`).
 *
 * The sweep used to enumerate the raw clip list — main timeline plus one level
 * of `project.timelines` — which is a different set from the resolved leaves:
 *
 * - An advanced title bakes FULL-CANVAS, so its position comes entirely from
 *   the PNG. Resolution composes a nested clip's geometry with its ancestors'
 *   (`compound.ts:976`), and the old sweep handed `drawTitle` the STORED inner
 *   clip, so a title inside a moved compound was rasterized — and exported —
 *   at the wrong place on the canvas. A shape is unaffected: it bakes
 *   box-local content and the graph places the box.
 * - `Object.values(project.timelines)` enumerates EVERY nested timeline, so the
 *   old sweep also baked clips the render can never reach (orphaned, cyclic, or
 *   outside their compound's window) — temp-dir writes for layers no graph
 *   input ever asks for.
 *
 * The sweep now walks `resolveRenderTimeline`, so the candidates are exactly
 * the resolved leaves the graph looks up, at any depth, and nothing else.
 *
 * OffscreenCanvas and the `export:bake-titles` IPC are stubbed the way
 * `renderer/engine/nested-raster.test.ts` stubs the canvas.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createEmptyProject } from '../../shared/types/project';
import type { Clip, Project, Timeline, Track } from '../../shared/types/project';
import { hasShapeContent } from '../../shared/editor/shape';
import { resolveRenderTimeline } from '../../shared/editor/compound';
import { isAdvancedTitle } from '../../shared/editor/title';
import { buildFfmpegArgs } from '../../main/media/export-args';
import { bakeExportLayers, collectBakeCandidates, type BakeCandidates } from './ExportDialog';

const BAKE_DIR = 'C:/baked/run-1';
const VIDEO_PATH = 'X:/media/clip.mp4';
const PROJECT_WIDTH = 320;
const PROJECT_HEIGHT = 240;

// ─── Stubs ───────────────────────────────────────────────────────────────────

/** One `fillText` call: the baked title's drawn position on the canvas. */
let drawnText: Array<{ text: string; x: number; y: number }> = [];

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
  fillText(text: string, x: number, y: number): void {
    drawnText.push({ text, x, y });
  }
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
  async convertToBlob(): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }> {
    return { arrayBuffer: async () => new ArrayBuffer(8) };
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
  async convertToBlob(): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }> {
    return this.ctx.convertToBlob();
  }
}

/** One recorded `export:bake-titles` call: the clip ids and canvas sizes. */
let bakeCalls: Array<{ clipIds: string[]; canvasSizes: Array<[number, number]> }> = [];
/** Box size per shape id, for the canvas-size assertion. */
let shapeBoxById: Map<string, [number, number]> = new Map();

beforeEach(() => {
  bakeCalls = [];
  drawnText = [];
  shapeBoxById = new Map();
  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
  // Mirrors `main/media/exporter.ts:475`: one `<clipId>.png` per entry, in the
  // order the entries arrived, inside one per-export temp directory.
  vi.stubGlobal('window', {
    palmier: {
      export: {
        bakeTitles: (files: Array<{ clipId: string }>) => {
          bakeCalls.push({
            clipIds: files.map((file) => file.clipId),
            canvasSizes: files.map((file) => shapeBoxById.get(file.clipId) ?? [PROJECT_WIDTH, PROJECT_HEIGHT]),
          });
          return Promise.resolve({
            success: true,
            dir: BAKE_DIR,
            paths: files.map((file) => `${BAKE_DIR}/${file.clipId}.png`),
          });
        },
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const bakedPaths = (result: Awaited<ReturnType<typeof bakeExportLayers>>) =>
  new Map((result?.bakedTitles ?? []).map((entry) => [entry.clipId, entry.path] as const));

// ─── Fixtures ────────────────────────────────────────────────────────────────

let clipSeq = 0;
function clip(overrides: Partial<Clip> = {}): Clip {
  clipSeq += 1;
  return {
    id: `clip-${clipSeq}`,
    assetId: 'v',
    type: 'video',
    trackId: 'v1',
    startFrame: 0,
    durationFrames: 30,
    inPoint: 0,
    outPoint: 30,
    x: 0,
    y: 0,
    width: PROJECT_WIDTH,
    height: PROJECT_HEIGHT,
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

function track(id: string, order: number): Track {
  return { id, name: id.toUpperCase(), type: 'video', locked: false, visible: true, syncLocked: true, order };
}

/** Advanced = needs the bake pipeline (titleFillMode alone is enough). */
function advancedTitle(id: string, text: string, overrides: Partial<Clip> = {}): Clip {
  return clip({
    id,
    type: 'title',
    assetId: '__title__',
    trackId: 't1',
    inPoint: 0,
    outPoint: 30,
    text,
    titleFillMode: 'footage',
    ...overrides,
  });
}

/** A plain (drawtext) title: never a bake candidate. */
function plainTitle(id: string, text: string, overrides: Partial<Clip> = {}): Clip {
  return clip({ id, type: 'title', assetId: '__title__', trackId: 't1', inPoint: 0, outPoint: 30, text, ...overrides });
}

/** A shape with a visible stroke, so `hasShapeContent` is true. */
function shape(id: string, overrides: Partial<Clip> = {}): Clip {
  return clip({
    id,
    type: 'shape',
    assetId: '__shape__',
    trackId: 'v1',
    inPoint: 0,
    outPoint: 30,
    x: 10,
    y: 20,
    width: 200,
    height: 120,
    shapeKind: 'arrow',
    shapeStrokeColor: '#ff0000',
    shapeStrokeWidth: 6,
    ...overrides,
  });
}

function compound(id: string, timelineId: string, overrides: Partial<Clip> = {}): Clip {
  return clip({
    id,
    type: 'compound',
    assetId: '__compound__',
    trackId: 'v2',
    inPoint: 0,
    outPoint: 30,
    durationFrames: 30,
    label: 'Nest',
    ...overrides,
    compoundTimelineId: timelineId,
  });
}

function nested(clips: Clip[], name: string): Timeline {
  return { tracks: [track('v1', 1), track('t1', 2)], clips, playheadFrame: 0, name };
}

/** Main timeline with a video bed, a title track, and a nest track. */
function baseProject(): Project {
  const project = createEmptyProject();
  project.settings.width = PROJECT_WIDTH;
  project.settings.height = PROJECT_HEIGHT;
  project.media = [{
    id: 'v', path: VIDEO_PATH, filename: 'clip.mp4', type: 'video', duration: 600,
    width: PROJECT_WIDTH, height: PROJECT_HEIGHT, fileSize: 1, addedAt: '2026-01-01T00:00:00.000Z',
  }];
  project.timeline.tracks = [track('v1', 1), track('t1', 2), track('v2', 3)];
  project.timeline.clips = [clip({ id: 'bed', durationFrames: 60, inPoint: 0, outPoint: 60 })];
  return project;
}

/** Every box-sized shape in the project, for the canvas-size assertion. */
function indexShapeBoxes(project: Project): void {
  shapeBoxById = new Map(
    [...project.timeline.clips, ...Object.values(project.timelines ?? {}).flatMap((t) => t.clips)]
      .filter((c) => c.type === 'shape')
      .map((c) => [c.id, [Math.round(c.width), Math.round(c.height)] as [number, number]] as const),
  );
}

/**
 * The pre-fix enumeration, restated as the reference the real sweep is
 * compared against: the main timeline plus the clips of every nested timeline
 * in the record, drawn from the STORED clips rather than resolved leaves.
 */
function legacyCandidates(project: Project): BakeCandidates {
  const allClips = [
    ...project.timeline.clips,
    ...Object.values(project.timelines ?? {}).flatMap((nestedTimeline) => nestedTimeline.clips),
  ];
  return {
    titles: allClips.filter(isAdvancedTitle),
    shapes: allClips.filter((clip) => clip.type === 'shape' && hasShapeContent(clip)),
  };
}

const ids = (clips: Clip[]) => clips.map((clip) => clip.id);

// ─── Nesting ─────────────────────────────────────────────────────────────────

describe('export bake sweep across compound nesting', () => {
  it('bakes a shape two levels deep under its resolved leaf id', async () => {
    const project = baseProject();
    project.timeline.clips.push(compound('outer', 'n1', { startFrame: 100 }));
    project.timelines = {
      n1: nested([compound('inner', 'n2', { trackId: 'v1', durationFrames: 20, outPoint: 20 })], 'Outer'),
      n2: nested([shape('deep-shape', { startFrame: 5, durationFrames: 10, outPoint: 10 })], 'Inner'),
    };
    indexShapeBoxes(project);

    const result = await bakeExportLayers(project, PROJECT_WIDTH, PROJECT_HEIGHT);
    // The precondition: the graph really does see this shape as a leaf.
    const paths = bakedPaths(result);
    expect(paths.get('deep-shape')).toBe(`${BAKE_DIR}/deep-shape.png`);
    expect(paths.size).toBe(1);
    // Box-sized, not full-canvas: the shared shape renderer draws box content.
    expect(bakeCalls[0]!.canvasSizes).toEqual([[200, 120]]);
  });

  it('bakes an advanced title two levels deep', async () => {
    const project = baseProject();
    project.timeline.clips.push(compound('outer', 'n1', { startFrame: 100 }));
    project.timelines = {
      n1: nested([compound('inner', 'n2', { trackId: 'v1', durationFrames: 20, outPoint: 20 })], 'Outer'),
      n2: nested([advancedTitle('deep-title', 'Deep', { startFrame: 5, durationFrames: 10, outPoint: 10 })], 'Inner'),
    };
    indexShapeBoxes(project);

    const result = await bakeExportLayers(project, PROJECT_WIDTH, PROJECT_HEIGHT);
    expect(bakedPaths(result).get('deep-title')).toBe(`${BAKE_DIR}/deep-title.png`);
    // Full-canvas RGBA, like every other advanced title.
    expect(bakeCalls[0]!.canvasSizes).toEqual([[PROJECT_WIDTH, PROJECT_HEIGHT]]);
  });

  it('bakes three levels deep', async () => {
    const project = baseProject();
    project.timeline.clips.push(compound('l1', 'n1', { startFrame: 100 }));
    project.timelines = {
      n1: nested([compound('l2', 'n2', { trackId: 'v1', durationFrames: 20, outPoint: 20 })], 'Level 1'),
      n2: nested([compound('l3', 'n3', { trackId: 'v1', durationFrames: 20, outPoint: 20 })], 'Level 2'),
      n3: nested([
        shape('deepest-shape', { startFrame: 2, durationFrames: 8, outPoint: 8 }),
        advancedTitle('deepest-title', 'Deepest', { startFrame: 2, durationFrames: 8, outPoint: 8 }),
      ], 'Level 3'),
    };
    indexShapeBoxes(project);

    const result = await bakeExportLayers(project, PROJECT_WIDTH, PROJECT_HEIGHT);
    const paths = bakedPaths(result);
    expect(paths.get('deepest-shape')).toBe(`${BAKE_DIR}/deepest-shape.png`);
    expect(paths.get('deepest-title')).toBe(`${BAKE_DIR}/deepest-title.png`);
    expect(paths.size).toBe(2);
  });

  it('never gives a compound clip a bake entry', async () => {
    const project = baseProject();
    project.timeline.clips.push(compound('outer', 'n1', { startFrame: 100 }));
    project.timelines = {
      n1: nested([
        compound('inner', 'n2', { trackId: 'v1', durationFrames: 20, outPoint: 20 }),
        advancedTitle('nested-title', 'Nested'),
        shape('nested-shape'),
      ], 'Outer'),
      n2: nested([shape('deep-shape', { startFrame: 5, durationFrames: 10, outPoint: 10 })], 'Inner'),
    };
    indexShapeBoxes(project);

    const result = await bakeExportLayers(project, PROJECT_WIDTH, PROJECT_HEIGHT);
    // A compound has no pixels of its own — resolution emits leaves only, so it
    // cannot even reach the candidate lists.
    expect([...bakedPaths(result).keys()].sort())
      .toEqual(['deep-shape', 'nested-shape', 'nested-title']);
    const candidates = collectBakeCandidates(project);
    expect(candidates.titles.every((c) => c.type === 'title')).toBe(true);
    expect(candidates.shapes.every((c) => c.type === 'shape')).toBe(true);
  });

  it('bakes a shape inside a shape-bearing nest the graph actually composites', async () => {
    // A shape bakes box-local content, so its position never diverges — the ids
    // are the whole contract, and they are the resolved leaf ids.
    const project = baseProject();
    project.timeline.clips.push(compound('outer', 'n1', { startFrame: 100 }));
    project.timelines = {
      n1: nested([compound('inner', 'n2', { trackId: 'v1', durationFrames: 20, outPoint: 20 })], 'Outer'),
      n2: nested([shape('deep-shape', { startFrame: 5, durationFrames: 10, outPoint: 10, label: 'Arrow' })], 'Inner'),
    };
    indexShapeBoxes(project);

    const result = await bakeExportLayers(project, PROJECT_WIDTH, PROJECT_HEIGHT);
    const warnings: string[] = [];
    const args = buildFfmpegArgs(
      project,
      { outputPath: 'out.mp4', format: 'mp4', quality: 'draft', bakedTitles: result!.bakedTitles },
      PROJECT_WIDTH,
      PROJECT_HEIGHT,
      30,
      120,
      warnings,
    );
    // No `export:warning`: the graph found the baked layer for its resolved id.
    expect(warnings).toEqual([]);
    expect(args).toContain(`${BAKE_DIR}/deep-shape.png`);
    expect(args).toContain('-loop'); // a baked still streams as a looping input
  });

  it('bakes a nested title at its resolved position, not its stored one', async () => {
    const project = baseProject();
    // The nest is moved, so resolution composes the inner title's box onto it.
    project.timeline.clips.push(
      compound('nest', 'n1', { startFrame: 100, x: 200, y: 120 }),
    );
    project.timelines = { n1: nested([advancedTitle('nested-title', 'Nested', { x: 40, y: 60 })], 'Nest') };
    indexShapeBoxes(project);

    await bakeExportLayers(project, PROJECT_WIDTH, PROJECT_HEIGHT);
    // drawTitle centres the glyphs on x + width/2, y + height/2. The resolved
    // leaf adds the nest's 200/120; the raw inner clip does not. An advanced
    // title bakes full-canvas and the graph overlays it with no x/y, so a PNG
    // drawn at the stored position is a title in the wrong place on screen.
    expect(drawnText).toHaveLength(1);
    expect(drawnText[0]).toMatchObject({ text: 'Nested', x: 200 + 40 + PROJECT_WIDTH / 2 });
    expect(drawnText[0]!.y).toBe(120 + 60 + PROJECT_HEIGHT / 2);
    // The old sweep handed drawTitle the stored inner clip instead.
    const stored = legacyCandidates(project).titles[0]!;
    expect(stored.x + PROJECT_WIDTH / 2).not.toBe(drawnText[0]!.x);
  });

  it('skips a layer the render can never reach', async () => {
    // An orphaned nested timeline (no compound references it) never resolves, so
    // the graph never asks for its shape; the raw merge baked it anyway and
    // wrote a PNG for a layer no input would consume.
    const project = baseProject();
    project.timeline.clips.push(compound('nest', 'n1', { startFrame: 100 }));
    project.timelines = {
      n1: nested([shape('live-shape')], 'Live'),
      orphan: nested([shape('orphan-shape'), advancedTitle('orphan-title', 'Orphan')], 'Orphan'),
    };
    indexShapeBoxes(project);
    // The precondition: the orphan is in the record but not in the render.
    expect(resolveRenderTimeline(project).clips.some((c) => c.id === 'orphan-shape')).toBe(false);
    expect(legacyCandidates(project).shapes.map((c) => c.id).sort())
      .toEqual(['live-shape', 'orphan-shape']);

    const result = await bakeExportLayers(project, PROJECT_WIDTH, PROJECT_HEIGHT);
    expect(bakedPaths(result).get('live-shape')).toBe(`${BAKE_DIR}/live-shape.png`);
    expect(bakedPaths(result).has('orphan-shape')).toBe(false);
    expect(bakedPaths(result).has('orphan-title')).toBe(false);
  });

  it('still bakes a shared nested timeline once per resolving compound', async () => {
    // Two compounds reference one timeline: two resolved leaves share a clip id
    // and one bake entry serves both, which is what the graph's lookup expects.
    const project = baseProject();
    project.timeline.clips.push(
      compound('nest-a', 'n1', { startFrame: 100 }),
      compound('nest-b', 'n1', { startFrame: 200 }),
    );
    project.timelines = { n1: nested([shape('shared-shape')], 'Shared') };
    indexShapeBoxes(project);

    const result = await bakeExportLayers(project, PROJECT_WIDTH, PROJECT_HEIGHT);
    const warnings: string[] = [];
    buildFfmpegArgs(
      project,
      { outputPath: 'out.mp4', format: 'mp4', quality: 'draft', bakedTitles: result!.bakedTitles },
      PROJECT_WIDTH,
      PROJECT_HEIGHT,
      30,
      240,
      warnings,
    );
    expect(warnings).toEqual([]);
    expect(bakedPaths(result).get('shared-shape')).toBe(`${BAKE_DIR}/shared-shape.png`);
  });

  it('bakes nothing and touches no temp dir for a project with no candidates', async () => {
    const project = baseProject();
    project.timeline.clips.push(compound('outer', 'n1', { startFrame: 100 }));
    project.timelines = {
      n1: nested([
        clip({ id: 'nested-video' }),
        // A plain title is drawtext's job, and a shape with no stroke or fill
        // draws nothing — neither is a bake candidate.
        plainTitle('plain-title', 'Plain'),
        shape('empty-shape', { shapeStrokeColor: undefined, shapeStrokeWidth: undefined }),
      ], 'Outer'),
    };
    indexShapeBoxes(project);

    const result = await bakeExportLayers(project, PROJECT_WIDTH, PROJECT_HEIGHT);
    expect(result).toBeUndefined();
    expect(bakeCalls).toEqual([]);
    expect(collectBakeCandidates(project)).toEqual({ titles: [], shapes: [] });
  });
});

// ─── Depth 1: unchanged ──────────────────────────────────────────────────────

describe('export bake sweep at one level of nesting', () => {
  /** Main title + main shape + one nested timeline holding a title and a shape. */
  function oneLevelProject(): Project {
    const project = baseProject();
    project.timeline.clips.push(
      advancedTitle('main-title', 'Main'),
      shape('main-shape'),
      compound('nest', 'n1', { startFrame: 100 }),
    );
    project.timelines = {
      n1: nested([advancedTitle('nested-title', 'Nested'), shape('nested-shape')], 'Nest'),
    };
    return project;
  }

  it('produces the same bakedTitles map as the one-level merge', async () => {
    const project = oneLevelProject();
    indexShapeBoxes(project);
    const legacy = legacyCandidates(project);
    const legacyIds = [...ids(legacy.titles), ...ids(legacy.shapes)];

    const result = await bakeExportLayers(project, PROJECT_WIDTH, PROJECT_HEIGHT);
    // Titles first, then shapes — the pairing the graph reads, unchanged.
    expect(result!.bakedTitles.map((entry) => entry.clipId)).toEqual(legacyIds);
    expect(result!.bakedTempDir).toBe(BAKE_DIR);
    expect(result!.bakedTitles).toEqual(
      legacyIds.map((id) => ({ clipId: id, path: `${BAKE_DIR}/${id}.png` })),
    );
  });

  it('bakes a flat (compound-free) project exactly as before', async () => {
    const project = baseProject();
    project.timeline.clips.push(advancedTitle('flat-title', 'Flat'), shape('flat-shape'));
    indexShapeBoxes(project);
    const legacy = legacyCandidates(project);

    const result = await bakeExportLayers(project, PROJECT_WIDTH, PROJECT_HEIGHT);
    expect(result!.bakedTitles.map((entry) => entry.clipId))
      .toEqual([...ids(legacy.titles), ...ids(legacy.shapes)]);
    expect(result!.bakedTitles).toHaveLength(2);
    // Box-sized for the shape, full-canvas for the title.
    expect(bakeCalls[0]!.canvasSizes).toEqual([[PROJECT_WIDTH, PROJECT_HEIGHT], [200, 120]]);
  });
});
