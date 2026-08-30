/**
 * Regression coverage for compositing renderer-rasterized title layers into
 * the live preview (title-preview GPU-parity fix).
 *
 * Title clips have no decodable media asset, so PreviewCompositor cannot
 * resolve them through the normal decode path -- the renderer rasterizes
 * them (title-raster-cache.ts) and hands the RGBA buffers in via `titles`.
 * A fake native addon captures the exact layer descriptor PreviewCompositor
 * builds, which is what pins the bug this fix corrects: a title's GPU layer
 * must be positioned using the *raster's own* x/y (its clip box for a plain
 * title, the canvas origin for an advanced one) and must never carry the
 * clip's rotation/scale/anchor, since export's title paths never apply
 * those to a title either -- forwarding them would make preview show a
 * transform export can't reproduce.
 */
import { describe, it, expect } from 'vitest';
import { createEmptyProject } from '../../shared/types/project';
import type { Clip, Project } from '../../shared/types/project';
import { PreviewCompositor, type TitleRasterInput } from './preview-compositor';

interface CapturedLayerDesc {
  width: number;
  height: number;
  x: number;
  y: number;
  opacity: number;
  rotation_deg: number;
  scale_x: number;
  scale_y: number;
  anchor_x: number;
  anchor_y: number;
  blend_mode: number;
  wipe_mode: number;
  wipe_progress: number;
  wipe_softness: number;
}

function titleClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'title-1',
    assetId: '__title__',
    type: 'title',
    trackId: 'v1',
    startFrame: 0,
    durationFrames: 90,
    inPoint: 0,
    outPoint: 90,
    text: 'Hello',
    x: 100,
    y: 50,
    width: 400,
    height: 120,
    // Deliberately non-identity so the assertions can prove these are NOT
    // forwarded to the GPU layer -- export never applies them to a title.
    rotation: 30,
    scaleX: 2,
    scaleY: 2,
    anchorX: 200,
    anchorY: 60,
    opacity: 1,
    volume: 1,
    muted: false,
    ...overrides,
  } as Clip;
}

function projectWithTitle(clip: Clip): Project {
  const project = createEmptyProject();
  project.timeline.clips = [clip];
  return project;
}

/** Fake native addon: records the parsed layer descriptors and returns a stub buffer. */
function fakeNativeAddon(): { addon: { compositeFrameGpu: (...args: unknown[]) => Buffer }; captured: CapturedLayerDesc[][] } {
  const captured: CapturedLayerDesc[][] = [];
  const addon = {
    compositeFrameGpu: (layersJson: string, _buffers: Buffer, width: number, height: number): Buffer => {
      captured.push(JSON.parse(layersJson));
      return Buffer.alloc(width * height * 4);
    },
  };
  return { addon, captured };
}

async function compositeWithFakeAddon(
  clip: Clip,
  titles: TitleRasterInput[],
  frameIndex = 10,
  projectOverride?: (project: Project) => void,
): Promise<CapturedLayerDesc[]> {
  const compositor = new PreviewCompositor();
  const { addon, captured } = fakeNativeAddon();
  compositor.setNativeAddon(addon);

  const project = projectWithTitle(clip);
  projectOverride?.(project);
  compositor.setProject(project);

  const fakeWin = {
    webContents: { id: 1, send: () => {} },
    isDestroyed: () => false,
  } as unknown as Parameters<PreviewCompositor['compositeFrame']>[1];
  await compositor.compositeFrame(frameIndex, fakeWin, titles);

  return captured[0] ?? [];
}

describe('PreviewCompositor title layer geometry', () => {
  it('positions a plain title raster at the raster box, ignoring clip.x/y and clip.rotation/scale/anchor', async () => {
    const clip = titleClip({ x: 100, y: 50, width: 400, height: 120 });
    const raster: TitleRasterInput = {
      clipId: clip.id,
      width: 400,
      height: 120,
      x: 100,
      y: 50,
      rgba: Buffer.alloc(400 * 120 * 4, 255),
    };

    const layers = await compositeWithFakeAddon(clip, [raster]);
    expect(layers).toHaveLength(1);
    expect(layers[0]).toMatchObject({
      width: 400,
      height: 120,
      x: 100,
      y: 50,
      rotation_deg: 0,
      scale_x: 1,
      scale_y: 1,
      anchor_x: 0,
      anchor_y: 0,
    });
  });

  it('places an advanced (full-canvas) title raster at the canvas origin', async () => {
    const clip = titleClip({ x: 100, y: 50, titleFillMode: 'footage' });
    const raster: TitleRasterInput = {
      clipId: clip.id,
      width: 1920,
      height: 1080,
      x: 0,
      y: 0,
      rgba: Buffer.alloc(1920 * 1080 * 4, 255),
    };

    const layers = await compositeWithFakeAddon(clip, [raster]);
    expect(layers).toHaveLength(1);
    expect(layers[0]).toMatchObject({ width: 1920, height: 1080, x: 0, y: 0 });
  });

  it('applies the clip opacity and blend mode to the title layer', async () => {
    const clip = titleClip({ opacity: 0.5, blendMode: 'multiply' });
    const raster: TitleRasterInput = {
      clipId: clip.id,
      width: 400,
      height: 120,
      x: 100,
      y: 50,
      rgba: Buffer.alloc(400 * 120 * 4, 255),
    };

    const layers = await compositeWithFakeAddon(clip, [raster]);
    expect(layers[0]!.opacity).toBe(0.5);
    expect(layers[0]!.blend_mode).toBe(1); // multiply index, blend-mode.ts
  });

  it('offsets the title layer by a slide-in transition without altering its size', async () => {
    const clip = titleClip({
      x: 100,
      y: 50,
      width: 400,
      height: 120,
      transitionIn: { type: 'slide', direction: 'left', frames: 10 },
    });
    const raster: TitleRasterInput = {
      clipId: clip.id,
      width: 400,
      height: 120,
      x: 100,
      y: 50,
      rgba: Buffer.alloc(400 * 120 * 4, 255),
    };

    // Frame 0 of a 10-frame slide-in from the left starts fully offscreen.
    const layers = await compositeWithFakeAddon(clip, [raster], 0);
    expect(layers[0]!.x).toBe(100 - 400); // clip.x - clip.width (fully offscreen left)
    expect(layers[0]!.y).toBe(50);
    expect(layers[0]!.width).toBe(400);
  });

  it('drops the title layer silently when the renderer has not rasterized it yet', async () => {
    const clip = titleClip();
    const layers = await compositeWithFakeAddon(clip, [] /* no matching raster */);
    expect(layers).toHaveLength(0);
  });

  it('excludes a title clip outside the requested frame range', async () => {
    const clip = titleClip({ startFrame: 0, durationFrames: 10 });
    const raster: TitleRasterInput = {
      clipId: clip.id,
      width: 400,
      height: 120,
      x: 100,
      y: 50,
      rgba: Buffer.alloc(400 * 120 * 4, 255),
    };
    const layers = await compositeWithFakeAddon(clip, [raster], 50); // past [0,10)
    expect(layers).toHaveLength(0);
  });

  it('excludes a title on a hidden track', async () => {
    const clip = titleClip();
    const raster: TitleRasterInput = {
      clipId: clip.id,
      width: 400,
      height: 120,
      x: 100,
      y: 50,
      rgba: Buffer.alloc(400 * 120 * 4, 255),
    };
    const layers = await compositeWithFakeAddon(clip, [raster], 10, (project) => {
      project.timeline.tracks[0]!.visible = false;
    });
    expect(layers).toHaveLength(0);
  });

  it('excludes a title on a non-soloed track when another track is soloed', async () => {
    const clip = titleClip({ trackId: 'v1' });
    const raster: TitleRasterInput = {
      clipId: clip.id,
      width: 400,
      height: 120,
      x: 100,
      y: 50,
      rgba: Buffer.alloc(400 * 120 * 4, 255),
    };
    const layers = await compositeWithFakeAddon(clip, [raster], 10, (project) => {
      // Solo a different track; v1 (the title's track) is not soloed.
      project.timeline.tracks[0]!.soloed = false;
      project.timeline.tracks[1]!.soloed = true;
    });
    expect(layers).toHaveLength(0);
  });
});
