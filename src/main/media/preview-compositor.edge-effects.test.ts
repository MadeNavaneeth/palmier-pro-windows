/**
 * Regression coverage for edge effects in the active main-process preview.
 * The decoder is mocked with synthetic RGBA and the native compositor is a
 * pass-through, so these tests observe the exact buffer uploaded for the
 * live layer rather than the dead renderer engine.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyProject } from '../../shared/types/project';
import type { Clip, Project } from '../../shared/types/project';
import { applyGradeToRgba, colorGradeOf } from '../../shared/editor/color-grade';
import { PreviewCompositor } from './preview-compositor';

const WIDTH = 32;
const HEIGHT = 32;

const decoderState = vi.hoisted(() => ({
  data: new Uint8Array(0),
  width: 0,
  height: 0,
}));

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  ipcMain: { handle: vi.fn() },
  default: {},
}));

vi.mock('./frame-decoder', () => ({
  getFrameDecoder: () => ({
    getFrame: async () => ({
      assetPath: 'synthetic.mp4',
      sourceSeconds: 0,
      width: decoderState.width,
      height: decoderState.height,
      data: Buffer.from(decoderState.data),
      decodedAt: Date.now(),
    }),
    prefetch: async () => {},
  }),
}));

function fillSource(): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 100;
    data[i + 1] = 120;
    data[i + 2] = 140;
    data[i + 3] = 255;
  }
  return data;
}

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'clip-1',
    assetId: 'asset-1',
    type: 'video',
    trackId: 'v1',
    startFrame: 0,
    durationFrames: 10,
    inPoint: 0,
    outPoint: 10,
    x: 0,
    y: 0,
    width: WIDTH,
    height: HEIGHT,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    anchorX: WIDTH / 2,
    anchorY: HEIGHT / 2,
    opacity: 1,
    volume: 1,
    muted: false,
    ...overrides,
  } as Clip;
}

function makeProject(clip: Clip): Project {
  const project = createEmptyProject();
  project.settings.width = WIDTH;
  project.settings.height = HEIGHT;
  project.media = [{
    id: 'asset-1',
    path: 'synthetic.mp4',
    filename: 'synthetic.mp4',
    type: 'video',
    duration: 10,
    fps: 30,
    fileSize: 1,
    addedAt: new Date().toISOString(),
  }];
  project.timeline.clips = [clip];
  return project;
}

async function runPreview(clip: Clip): Promise<Buffer> {
  const sent: Buffer[] = [];
  const compositor = new PreviewCompositor();
  compositor.setNativeAddon({
    // One layer means the uploaded source buffer is the composited result for
    // these focused pixel assertions; this still exercises the active
    // decode -> grade/effects -> edge-mask -> GPU path.
    compositeFrameGpu: (_layersJson: string, buffers: Buffer): Buffer => buffers,
  });
  compositor.setProject(makeProject(clip));

  const window = {
    webContents: {
      id: 1,
      send: (_channel: string, frame: Buffer) => sent.push(frame),
    },
    isDestroyed: () => false,
  } as unknown as Parameters<PreviewCompositor['compositeFrame']>[1];

  await compositor.compositeFrame(0, window);
  expect(sent).toHaveLength(1);
  return sent[0]!;
}

function pixel(frame: Uint8Array, x: number, y: number): [number, number, number, number] {
  const index = (y * WIDTH + x) * 4;
  return [frame[index], frame[index + 1], frame[index + 2], frame[index + 3]];
}

describe('PreviewCompositor edge effects (#369)', () => {
  let source: Uint8Array<ArrayBuffer>;

  beforeEach(() => {
    source = fillSource();
    decoderState.data = source;
    decoderState.width = WIDTH;
    decoderState.height = HEIGHT;
  });

  it('rounds corners in the active preview while leaving the center unchanged', async () => {
    const output = await runPreview(makeClip({ edgeRounding: 0.5 }));

    expect(pixel(output, 0, 0)[3]).toBeLessThan(255);
    expect(pixel(output, 16, 16)).toEqual(pixel(source, 16, 16));
    // The midpoint of a straight edge is outside the rounded corner region.
    expect(pixel(output, 16, 0)).toEqual(pixel(source, 16, 0));
  });

  it('produces a feathered alpha ramp for edge softness', async () => {
    const output = await runPreview(makeClip({ edgeSoftness: 0.25 }));
    const edgeAlpha = pixel(output, 0, 16)[3];
    const firstStepAlpha = pixel(output, 1, 16)[3];
    const middleStepAlpha = pixel(output, 2, 16)[3];
    const interiorAlpha = pixel(output, 4, 16)[3];

    expect(edgeAlpha).toBe(0);
    expect(edgeAlpha).toBeLessThan(firstStepAlpha);
    expect(firstStepAlpha).toBeLessThan(middleStepAlpha);
    expect(middleStepAlpha).toBeLessThan(interiorAlpha);
    expect(interiorAlpha).toBe(255);
  });

  it('keeps the both-zero path byte-identical to the unprocessed path', async () => {
    const unprocessed = await runPreview(makeClip());
    const explicitZero = await runPreview(makeClip({ edgeRounding: 0, edgeSoftness: 0 }));

    expect(Buffer.from(explicitZero).equals(Buffer.from(unprocessed))).toBe(true);
    expect(Buffer.from(explicitZero).equals(Buffer.from(source))).toBe(true);
  });

  it('applies the grade before the edge mask on an edge-affected pixel', async () => {
    const clip = makeClip({ brightness: 0.25, edgeSoftness: 0.25 });
    const expected = Buffer.from(source);
    applyGradeToRgba(expected, colorGradeOf(clip)!);

    const output = await runPreview(clip);
    const actual = pixel(output, 2, 16);
    const expectedPixel = pixel(expected, 2, 16);

    expect(actual.slice(0, 3)).toEqual(expectedPixel.slice(0, 3));
    expect(actual[3]).toBeGreaterThan(0);
    expect(actual[3]).toBeLessThan(255);
  });
});
