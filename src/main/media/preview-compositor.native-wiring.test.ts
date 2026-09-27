/**
 * The native compositor addon has to actually reach the compositor.
 *
 * `PreviewCompositor.setNativeAddon` had no non-test caller, so `nativeAddon`
 * was null in every session and `composeToBuffer` always took the
 * `return buffers[0]` fallback: preview and marker thumbnails rendered the
 * bottom visible layer only, on every platform, and the whole 12-mode blend
 * compositor was dead in production. These tests pin the production path --
 * `getPreviewCompositorFor`, the only construction a real session uses -- so the
 * addon reaches it, is loaded once for the whole process rather than per
 * session, and a missing or failing addon still degrades to the documented
 * fallback instead of rejecting the frame.
 *
 * The loader is mocked so the wiring is proven independently of whether a Rust
 * build happens to be sitting in `native/`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createEmptyProject } from '../../shared/types/project';
import type { Clip, Project } from '../../shared/types/project';
import type { PreviewCompositor } from './preview-compositor';

const { loadNativeAddon, decodedFrame } = vi.hoisted(() => ({
  loadNativeAddon: vi.fn(),
  decodedFrame: {
    assetPath: 'C:/media/clip.mp4',
    sourceSeconds: 0,
    width: 64,
    height: 64,
    data: Buffer.alloc(64 * 64 * 4, 96),
    decodedAt: 0,
  },
}));

vi.mock('electron', () => ({
  ipcMain: { handle: () => {} },
  BrowserWindow: { fromWebContents: () => null },
  app: undefined,
  default: {},
}));

vi.mock('../ipc/system', () => ({ loadNativeAddon }));

vi.mock('./frame-decoder', () => ({
  getFrameDecoder: () => ({
    getFrame: async () => decodedFrame,
    prefetch: async () => {},
  }),
}));

/** A stand-in addon that records the layer payloads it was handed. */
function spyAddon() {
  const calls: { layers: unknown[]; bytes: number; width: number; height: number }[] = [];
  return {
    calls,
    compositeFrameGpu(layersJson: string, rgba: Buffer, width: number, height: number): Buffer {
      calls.push({ layers: JSON.parse(layersJson), bytes: rgba.length, width, height });
      return Buffer.alloc(width * height * 4, 7);
    },
  };
}

/** One video clip, so a frame has exactly one layer to composite. */
function projectWithVideoClip(width = 320, height = 180): Project {
  const project = createEmptyProject();
  project.settings.width = width;
  project.settings.height = height;
  project.media = [{
    id: 'm1',
    path: 'C:/media/clip.mp4',
    filename: 'clip.mp4',
    type: 'video',
    duration: 300,
    fps: 30,
    fileSize: 1,
    addedAt: new Date().toISOString(),
  }];
  project.timeline.clips = [{
    id: 'c1',
    assetId: 'm1',
    type: 'video',
    trackId: 'v1',
    startFrame: 0,
    durationFrames: 30,
    inPoint: 0,
    outPoint: 30,
    x: 0,
    y: 0,
    width: 64,
    height: 64,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    opacity: 1,
    anchorX: 0,
    anchorY: 0,
    volume: 1,
    muted: false,
  } as Clip];
  return project;
}

function fakeWin(contentsId: number) {
  const send = vi.fn();
  return {
    win: {
      webContents: { id: contentsId, send },
      isDestroyed: () => false,
    } as unknown as Parameters<PreviewCompositor['compositeFrame']>[1],
    send,
  };
}

/** Every `preview:frame` buffer a fake window received. */
function frames(send: ReturnType<typeof vi.fn>): Buffer[] {
  return send.mock.calls
    .filter((call) => call[0] === 'preview:frame')
    .map((call) => call[1] as Buffer);
}

/**
 * One published frame of the given size, filled with one byte value.
 *
 * Asserted by size and sampled bytes rather than deep equality: a 320x180 RGBA
 * frame is 230k entries and `toEqual` over one takes longer than the test
 * timeout, which says nothing extra about the wiring under test.
 */
function expectPixels(published: Buffer[], length: number, fill: number): void {
  expect(published).toHaveLength(1);
  expect(published[0]!.length).toBe(length);
  expect(published[0]![0]).toBe(fill);
  expect(published[0]![length - 1]).toBe(fill);
}

/** The canvas every case below composites onto. */
const CANVAS_WIDTH = 320;
const CANVAS_HEIGHT = 180;
/** Every byte of the mocked 64x64 decoded layer. */
const LAYER_FILL = 96;

/**
 * The degraded frame: the bottom layer's pixels on a 320x180 transparent
 * canvas, at the layer's own (0, 0).
 *
 * It has to be canvas-sized. PreviewCanvas accepts a `preview:frame` payload
 * only when it is exactly width*height*4 bytes and drops it otherwise, so the
 * previous `return buffers[0]` -- a 64x64 layer -- published *no* frame at all
 * rather than the bottom layer alone. Sampled rather than deep-compared for the
 * same reason as `expectPixels`.
 */
function expectBottomLayerOnCanvas(published: Buffer[]): void {
  expect(published).toHaveLength(1);
  const frame = published[0]!;
  expect(frame.length).toBe(CANVAS_WIDTH * CANVAS_HEIGHT * 4);
  const at = (x: number, y: number) => frame[(y * CANVAS_WIDTH + x) * 4];
  expect(at(0, 0)).toBe(LAYER_FILL);
  expect(at(63, 63)).toBe(LAYER_FILL);
  // Just outside the layer, in both directions, and the tail of the frame.
  expect(at(64, 0)).toBe(0);
  expect(at(0, 64)).toBe(0);
  expect(at(CANVAS_WIDTH - 1, CANVAS_HEIGHT - 1)).toBe(0);
}

/**
 * Load a fresh copy of the module so the process-wide addon memo is empty.
 * A fresh graph per case keeps one test's resolved addon out of the next.
 */
async function freshCompositors() {
  vi.resetModules();
  return import('./preview-compositor');
}

/** Let the un-awaited process-wide load settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * This file's real cost, and the vitest budget it needs.
 *
 * The first case below costs 545ms idle and 4.2-9.4s with the CPU
 * oversubscribed 3x (60 spinners on 20 cores), and ~99% of that is the cold
 * `import('./preview-compositor')` behind `freshCompositors()` -- the two
 * 320x180 composites are 2.4ms and 0.4ms. Re-importing per case is what keeps
 * one case's resolved addon out of the next, so the cost cannot be reduced
 * without giving that up, and vitest's 5000ms default sits below it.
 *
 * That is the flake: `Test timed out in 5000ms`, on a test whose work is
 * entirely synchronous. The timeout then cascaded into a second, misleading
 * failure -- vitest does not cancel a timed-out test, so the abandoned body
 * resumed later and called `getPreviewCompositorFor` again after the next
 * case's `mockReset()`, and the *next* test reported `expected "spy" to be
 * called 1 times, but got 2 times`. Both go away once the budget is honest.
 *
 * 30_000 is the budget `preview-compositor.real-addon.test.ts` already uses
 * for driver work, and is over 3x the worst case measured here. Set through
 * `vi.setConfig`, so it covers this file only -- the rest of the suite keeps
 * the 5s default -- and vitest charges measured time, not the budget, so an
 * idle box pays nothing for it.
 */
const LOAD_TIMEOUT_MS = 30_000;

vi.setConfig({ testTimeout: LOAD_TIMEOUT_MS });

beforeEach(() => {
  loadNativeAddon.mockReset();
  vi.restoreAllMocks();
});

describe('native addon wiring into production preview compositors', () => {
  it('hands the process-wide addon to every session compositor', async () => {
    const addon = spyAddon();
    loadNativeAddon.mockResolvedValue(addon);
    const { getPreviewCompositorFor, disposePreviewCompositor } = await freshCompositors();

    // Two sessions, two compositors -- both must end up with the addon.
    const a = getPreviewCompositorFor('wire-a');
    const b = getPreviewCompositorFor('wire-b');
    await settle();

    const { win: winA, send: sendA } = fakeWin(81);
    const { win: winB, send: sendB } = fakeWin(82);
    a.setProject(projectWithVideoClip());
    b.setProject(projectWithVideoClip());
    await a.compositeFrame(0, winA);
    await b.compositeFrame(0, winB);

    // Both sessions composited through the addon (a null nativeAddon would have
    // taken the first-layer fallback and never called it), and both published
    // the composited canvas rather than the 64x64 layer it was handed.
    expect(addon.calls).toHaveLength(2);
    expect(addon.calls[0]!.layers).toHaveLength(1);
    expect(addon.calls[0]!.bytes).toBe(64 * 64 * 4);
    expect(addon.calls[0]!.width).toBe(320);
    expect(addon.calls[0]!.height).toBe(180);
    expectPixels(frames(sendA), 320 * 180 * 4, 7);
    expectPixels(frames(sendB), 320 * 180 * 4, 7);
    disposePreviewCompositor('wire-a');
    disposePreviewCompositor('wire-b');
  });

  it('loads the addon once for the process, not once per session', async () => {
    loadNativeAddon.mockResolvedValue(spyAddon());
    const { getPreviewCompositorFor, disposePreviewCompositor } = await freshCompositors();

    getPreviewCompositorFor('once-a');
    getPreviewCompositorFor('once-b');
    getPreviewCompositorFor('once-c');
    await settle();

    expect(loadNativeAddon).toHaveBeenCalledTimes(1);
    disposePreviewCompositor('once-a');
    disposePreviewCompositor('once-b');
    disposePreviewCompositor('once-c');
  });

  it('gives a compositor created after the load settled the cached addon', async () => {
    const addon = spyAddon();
    loadNativeAddon.mockResolvedValue(addon);
    const { getPreviewCompositorFor, disposePreviewCompositor } = await freshCompositors();

    getPreviewCompositorFor('late-1');
    await settle();
    // No second load, and the new session still composites through the addon.
    const late = getPreviewCompositorFor('late-2');
    const { win, send } = fakeWin(91);
    late.setProject(projectWithVideoClip());
    await late.compositeFrame(0, win);

    expect(loadNativeAddon).toHaveBeenCalledTimes(1);
    expect(addon.calls).toHaveLength(1);
    expectPixels(frames(send), 320 * 180 * 4, 7);
    disposePreviewCompositor('late-1');
    disposePreviewCompositor('late-2');
  });

  it('composes a frame before the addon arrives without throwing', async () => {
    let release: (addon: unknown) => void = () => {};
    loadNativeAddon.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const { getPreviewCompositorFor, disposePreviewCompositor } = await freshCompositors();

    const compositor = getPreviewCompositorFor('racing');
    const { win, send } = fakeWin(101);
    compositor.setProject(projectWithVideoClip());
    await compositor.compositeFrame(0, win);
    // Pre-addon frame: the documented first-layer fallback, so what reaches the
    // renderer is that layer on a canvas-sized frame, not the raw layer.
    expectBottomLayerOnCanvas(frames(send));

    const addon = spyAddon();
    release(addon);
    await settle();
    await compositor.compositeFrame(1, win);
    expect(addon.calls).toHaveLength(1);
    disposePreviewCompositor('racing');
  });

  it('degrades to the bottom layer when no addon is present', async () => {
    loadNativeAddon.mockResolvedValue(null);
    const { getPreviewCompositorFor, disposePreviewCompositor } = await freshCompositors();

    const compositor = getPreviewCompositorFor('no-addon');
    await settle();
    const { win, send } = fakeWin(111);
    compositor.setProject(projectWithVideoClip());
    await expect(compositor.compositeFrame(0, win)).resolves.toBeUndefined();

    // The frame still publishes, carrying the first (bottom) layer's pixels
    // on a correctly sized canvas.
    expectBottomLayerOnCanvas(frames(send));
    disposePreviewCompositor('no-addon');
  });

  it('degrades and does not throw when the addon call itself fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    loadNativeAddon.mockResolvedValue({
      compositeFrameGpu: () => {
        throw new Error('Given napi value is not an array');
      },
    });
    const { getPreviewCompositorFor, disposePreviewCompositor } = await freshCompositors();

    const compositor = getPreviewCompositorFor('broken-addon');
    await settle();
    const { win, send } = fakeWin(121);
    compositor.setProject(projectWithVideoClip());
    await expect(compositor.compositeFrame(0, win)).resolves.toBeUndefined();
    expectBottomLayerOnCanvas(frames(send));

    // Latched: a broken addon is reported once, not once per frame.
    await compositor.compositeFrame(1, win);
    expect(frames(send)).toHaveLength(2);
    expect(console.error).toHaveBeenCalledTimes(1);
    disposePreviewCompositor('broken-addon');
  });

  /**
   * The one failure that must not latch. The Rust addon prefixes a lost device
   * with `PALMIER_GPU_DEVICE_LOST` and has already dropped it, so it rebuilds
   * device and pipeline on the next call -- latching here turned one recoverable
   * TDR into a session-long downgrade to the CPU compositor.
   */
  it('retries after a lost GPU device instead of latching the preview to the fallback', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let calls = 0;
    loadNativeAddon.mockResolvedValue({
      compositeFrameGpu: (_layersJson: string, rgba: Buffer, width: number, height: number) => {
        calls += 1;
        if (calls === 1) {
          throw new Error(
            'PALMIER_GPU_DEVICE_LOST: device lost (Unknown): DXGI_ERROR_DEVICE_RESET',
          );
        }
        return Buffer.alloc(width * height * 4, 7).fill(rgba[0] ?? 0);
      },
    });
    const { getPreviewCompositorFor, disposePreviewCompositor } = await freshCompositors();

    const compositor = getPreviewCompositorFor('device-lost');
    await settle();
    const { win } = fakeWin(131);
    compositor.setProject(projectWithVideoClip());

    // The lost frame degrades to the documented first-layer fallback...
    await expect(compositor.compositeFrame(0, win)).resolves.toBeUndefined();
    // ...and the very next frame reaches the addon again, on the rebuilt device.
    await expect(compositor.compositeFrame(1, win)).resolves.toBeUndefined();

    expect(calls, 'the addon must be retried, not latched out').toBe(2);
    expect(warnings).toHaveBeenCalledTimes(1);
    expect(errors, 'a recoverable loss is not a permanent addon failure').not.toHaveBeenCalled();
    disposePreviewCompositor('device-lost');
  });

  /**
   * The wait the other cases use must stay independent of machine load.
   *
   * `settle()` is a `setTimeout(..., 0)` macrotask, so it is only sound
   * while the addon is attached from the loader's `.then()` -- an
   * already-resolved promise continuation, and microtasks always run before
   * timers, which no amount of contention can reorder. That is why a slow
   * machine here cost a timeout and never a lost addon.
   *
   * This pins the premise rather than the symptom: the attach is recorded and
   * has to land before the first timer callback. If the wiring ever grew a
   * macrotask or IO hop before attaching, the order inverts and `settle()`
   * starts losing the race on a loaded machine -- the failure this file is
   * most likely to get wrong, and one no timeout can hide.
   */
  it('attaches the addon before any timer runs, so settle() cannot lose a race', async () => {
    const addon = spyAddon();
    loadNativeAddon.mockResolvedValue(addon);
    const { getPreviewCompositorFor, disposePreviewCompositor } = await freshCompositors();

    const order: string[] = [];
    const compositor = getPreviewCompositorFor('attach-order');
    // getPreviewCompositorFor queues the attach as a microtask, so recording
    // it here records it before it happens.
    const attach = compositor.setNativeAddon.bind(compositor);
    compositor.setNativeAddon = (loaded) => {
      order.push('attach');
      attach(loaded);
    };
    setTimeout(() => order.push('timer'), 0);
    await settle();

    expect(order, 'the addon must be attached on the microtask queue, before any macrotask')
      .toEqual(['attach', 'timer']);

    // And it is the real addon, not the fallback: the frame went through it.
    const { win, send } = fakeWin(141);
    compositor.setProject(projectWithVideoClip());
    await compositor.compositeFrame(0, win);
    expect(addon.calls).toHaveLength(1);
    expectPixels(frames(send), 320 * 180 * 4, 7);
    disposePreviewCompositor('attach-order');
  });
});
