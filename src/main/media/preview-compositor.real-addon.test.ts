/**
 * The production preview path against the REAL native addon.
 *
 * `preview-compositor.native-wiring.test.ts` proves the wiring with a stand-in
 * addon, which cannot catch anything wrong inside the Rust .node itself. This
 * one loads the actual artifact through the actual loader and composites, so
 * activating a path that has never run in production cannot silently break the
 * preview: the guarantee asserted is the user-facing one -- compositing resolves,
 * a frame is published every time, and a native failure costs at most one
 * diagnostic rather than one per frame.
 *
 * Skipped (by returning early) on a checkout that has not run
 * `npm run build:rust`; the addon is a build artifact, so its absence is not a
 * defect in this code.
 */
import { describe, it, expect, vi } from 'vitest';
import { existsSync } from 'fs';
import path from 'path';
import { createEmptyProject } from '../../shared/types/project';
import type { Clip, Project } from '../../shared/types/project';
import type { PreviewCompositor } from './preview-compositor';

const { decodedFrame } = vi.hoisted(() => ({
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

vi.mock('./frame-decoder', () => ({
  getFrameDecoder: () => ({
    getFrame: async () => decodedFrame,
    prefetch: async () => {},
  }),
}));

const REPO = path.resolve(__dirname, '..', '..', '..');
/** Either spelling the build can produce. */
function addonIsBuilt(): boolean {
  return ['palmier-compositor.node', `palmier-compositor.${process.platform}-${process.arch}.node`]
    .some((name) => existsSync(path.join(REPO, 'native', name)));
}

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

function fakeWin() {
  const send = vi.fn();
  return {
    win: {
      webContents: { id: 1, send },
      isDestroyed: () => false,
    } as unknown as Parameters<PreviewCompositor['compositeFrame']>[1],
    send,
  };
}

function frames(send: ReturnType<typeof vi.fn>): Buffer[] {
  return send.mock.calls
    .filter((call) => call[0] === 'preview:frame')
    .map((call) => call[1] as Buffer);
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('production preview path with the real native addon', () => {
  it('composites without throwing and keeps publishing frames', async () => {
    if (!addonIsBuilt()) return;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.resetModules();
    const { getPreviewCompositorFor, disposePreviewCompositor, } = await import('./preview-compositor');
    const { loadNativeAddon } = await import('../ipc/system');

    // The loader must actually find the artifact the build produced.
    expect(await loadNativeAddon()).not.toBeNull();

    const compositor = getPreviewCompositorFor('real-addon');
    await settle();
    const { win, send } = fakeWin();
    compositor.setProject(projectWithVideoClip());

    await expect(compositor.compositeFrame(0, win)).resolves.toBeUndefined();
    await expect(compositor.compositeFrame(1, win)).resolves.toBeUndefined();
    expect(frames(send)).toHaveLength(2);

    // A native failure is reported once and latched, never per frame.
    expect(errors.mock.calls.length).toBeLessThanOrEqual(1);
    errors.mockRestore();
    disposePreviewCompositor('real-addon');
    // Loads a real .node and composites with it: driver work, not a 5s-budget
    // unit test, and the rest of the suite may be competing for the same GPU.
  }, 30_000);
});
