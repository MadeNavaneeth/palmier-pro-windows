/**
 * Active main-process preview motion-track regression coverage.
 *
 * The decoder and native compositor are mocked with synthetic RGBA. The fake
 * native addon records the exact layer descriptor produced by
 * PreviewCompositor, so these assertions exercise the active decode -> GPU
 * path rather than the unused renderer preview engine.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyProject } from '../../shared/types/project';
import type { Clip, Project } from '../../shared/types/project';
import { evaluateMotion, type MotionTrack } from '../../shared/media/motion';
import { fadeMultiplier } from '../../shared/editor/fade';
import { PreviewCompositor } from './preview-compositor';

const WIDTH = 8;
const HEIGHT = 8;

interface CapturedLayer {
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

const decoderState = vi.hoisted(() => ({
  data: new Uint8Array(0),
  width: 0,
  height: 0,
}));

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  ipcMain: { handle: vi.fn() },
  app: undefined,
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
    data[i] = 10 + i;
    data[i + 1] = 20 + i;
    data[i + 2] = 30 + i;
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
    durationFrames: 90,
    inPoint: 0,
    outPoint: 90,
    x: 0,
    y: 0,
    width: WIDTH,
    height: HEIGHT,
    rotation: 11,
    scaleX: 1.25,
    scaleY: 0.75,
    opacity: 1,
    anchorX: 0,
    anchorY: 0,
    volume: 1,
    muted: false,
    ...overrides,
  } as Clip;
}

/** Add eased runtime tracks without widening the persisted Clip field type. */
function withMotion(
  overrides: Partial<Clip> = {},
  tracks: Partial<Record<'motionRot' | 'motionScaleX' | 'motionScaleY', MotionTrack>> = {},
): Clip {
  return Object.assign(makeClip(overrides), tracks);
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
    duration: 90,
    fps: 30,
    fileSize: 1,
    addedAt: new Date().toISOString(),
  }];
  project.timeline.clips = [clip];
  return project;
}

async function runPreview(
  clip: Clip,
  frameIndex: number,
): Promise<{ layer: CapturedLayer; output: Buffer }> {
  const captured: CapturedLayer[] = [];
  const sent: Buffer[] = [];
  const compositor = new PreviewCompositor();
  compositor.setNativeAddon({
    compositeFrameGpu: (layersJson: string, buffers: Buffer): Buffer => {
      captured.push((JSON.parse(layersJson) as CapturedLayer[])[0]!);
      return buffers;
    },
  });
  compositor.setProject(makeProject(clip));

  const window = {
    webContents: {
      id: 1,
      send: (channel: string, frame: Buffer) => {
        if (channel === 'preview:frame') sent.push(frame);
      },
    },
    isDestroyed: () => false,
  } as unknown as Parameters<PreviewCompositor['compositeFrame']>[1];

  await compositor.compositeFrame(frameIndex, window);
  expect(sent).toHaveLength(1);
  expect(captured).toHaveLength(1);
  return { layer: captured[0]!, output: sent[0]! };
}

describe('PreviewCompositor media motion tracks', () => {
  let source: Uint8Array<ArrayBuffer>;

  beforeEach(() => {
    source = fillSource();
    decoderState.data = source;
    decoderState.width = WIDTH;
    decoderState.height = HEIGHT;
  });

  it('animates a media clip rotation from motionRot in the active preview', async () => {
    const clip = withMotion({}, {
      motionRot: [
        { frame: 0, value: 0 },
        { frame: 30, value: 90 },
      ],
    });

    const first = await runPreview(clip, 0);
    const second = await runPreview(clip, 15);

    expect(first.layer.rotation_deg).toBe(0);
    expect(second.layer.rotation_deg).toBe(45);
    expect(second.layer.rotation_deg).not.toBe(first.layer.rotation_deg);
  });

  it('animates media clip scale X and scale Y independently from their tracks', async () => {
    const clip = withMotion({}, {
      motionScaleX: [
        { frame: 0, value: 1 },
        { frame: 30, value: 3 },
      ],
      motionScaleY: [
        { frame: 0, value: 2 },
        { frame: 30, value: 4 },
      ],
    });

    const first = await runPreview(clip, 0);
    const second = await runPreview(clip, 15);

    expect(first.layer.scale_x).toBe(1);
    expect(second.layer.scale_x).toBe(2);
    expect(first.layer.scale_y).toBe(2);
    expect(second.layer.scale_y).toBe(3);
  });

  it('animates rotation while retaining static scale when only rotation has a track', async () => {
    const clip = withMotion({
      rotation: 33,
      scaleX: 1.4,
      scaleY: 0.6,
    }, {
      motionRot: [
        { frame: 0, value: 0 },
        { frame: 30, value: 90 },
      ],
    });

    const first = await runPreview(clip, 0);
    const second = await runPreview(clip, 15);

    expect(first.layer.rotation_deg).toBe(0);
    expect(second.layer.rotation_deg).toBe(45);
    expect(first.layer.scale_x).toBe(1.4);
    expect(second.layer.scale_x).toBe(1.4);
    expect(first.layer.scale_y).toBe(0.6);
    expect(second.layer.scale_y).toBe(0.6);
  });

  it('animates media opacity from opacityTrack at two active frames', async () => {
    const opacityTrack: MotionTrack = [
      { frame: 0, value: 0.2 },
      { frame: 30, value: 0.8 },
    ];
    const clip = makeClip({ opacity: 0.05, opacityTrack });

    const first = await runPreview(clip, 0);
    const second = await runPreview(clip, 15);

    expect(first.layer.opacity).toBe(0.2);
    expect(second.layer.opacity).toBeCloseTo(evaluateMotion(opacityTrack, 15)!, 10);
    expect(second.layer.opacity).not.toBe(first.layer.opacity);
  });

  it('keeps static opacity and source bytes unchanged when no opacity track exists', async () => {
    const result = await runPreview(makeClip({ opacity: 0.35 }), 0);

    expect(result.layer.opacity).toBe(0.35);
    expect(Buffer.from(result.output).equals(Buffer.from(source))).toBe(true);
  });

  it('uses the shared easing evaluator for opacity and keeps fades separate', async () => {
    const opacityTrack: MotionTrack = [
      { frame: 0, value: 0, easing: 'easeInOut' },
      { frame: 30, value: 1 },
    ];
    const clip = makeClip({ opacity: 0.4, opacityTrack, fadeInFrames: 10 });
    const expected = evaluateMotion(opacityTrack, 8)! * fadeMultiplier(clip, 8);
    const result = await runPreview(clip, 8);

    expect(expected).not.toBeCloseTo(8 / 30, 6);
    expect(result.layer.opacity).toBeCloseTo(expected, 10);
    expect(result.layer.opacity).toBeLessThan(evaluateMotion(opacityTrack, 8)!);
  });

  it('keeps the no-track path on the exact static transform and source bytes', async () => {
    const result = await runPreview(makeClip({
      rotation: 37,
      scaleX: 1.4,
      scaleY: 0.6,
    }), 0);

    expect(result.layer).toMatchObject({
      rotation_deg: 37,
      scale_x: 1.4,
      scale_y: 0.6,
    });
    // The fake native compositor is pass-through, so this is the same uploaded
    // RGBA payload the pre-change static path produced.
    expect(Buffer.from(result.output).equals(Buffer.from(source))).toBe(true);
  });

  it('uses the shared easing evaluation for an easeInOut motion track', async () => {
    const motionRot: MotionTrack = [
      { frame: 0, value: 0, easing: 'easeInOut' },
      { frame: 30, value: 100 },
    ];
    const clip = withMotion({}, { motionRot });
    const expected = evaluateMotion(motionRot, 8)!;
    const result = await runPreview(clip, 8);

    expect(expected).not.toBeCloseTo(100 * (8 / 30), 6);
    expect(result.layer.rotation_deg).toBeCloseTo(expected, 10);
  });
});
