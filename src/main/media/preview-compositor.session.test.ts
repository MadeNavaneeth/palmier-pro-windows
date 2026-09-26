/**
 * Multi-session preview isolation (#137 Slice 3).
 *
 * Each session owns its PreviewCompositor instance (getPreviewCompositorFor),
 * so two windows previewing different projects get separate current-project
 * state, latest-request gates, and caches. The regression this pins: under
 * the Slice 1 process singleton, ANY session's setProject called
 * invalidateAll() and dropped every window's in-flight frame (and one shared
 * gate key meant a thumbnail request from A superseded B's).
 *
 * The IPC registrar is exercised through a captured `ipcMain.handle` with an
 * Electron stub: sender → session → compositor is the wiring Slice 3 adds.
 * Frame-decoder is mocked so one session's request can be held genuinely
 * in-flight while the other session runs to completion; empty projects
 * composite a transparent canvas without touching the decoder at all.
 */
import { describe, it, expect, vi } from 'vitest';
import { createEmptyProject } from '../../shared/types/project';
import type { Clip, Project } from '../../shared/types/project';
import {
  disposePreviewCompositor,
  getPreviewCompositorFor,
  registerPreviewHandlers,
  type PreviewCompositor,
} from './preview-compositor';

const { ipcHandlers, fromWebContents, decodeWaiters } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: any[]) => any>(),
  fromWebContents: vi.fn(),
  decodeWaiters: [] as Array<(frame: unknown) => void>,
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: any[]) => any) => {
      ipcHandlers.set(channel, listener);
    },
  },
  BrowserWindow: { fromWebContents },
  app: undefined,
  default: {},
}));

vi.mock('./frame-decoder', () => ({
  getFrameDecoder: () => ({
    getFrame: () =>
      new Promise((resolve) => {
        decodeWaiters.push(resolve);
      }),
    prefetch: async () => {},
  }),
}));

function fakeWin(contentsId: number): {
  win: Parameters<PreviewCompositor['compositeFrame']>[1];
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn();
  const win = {
    webContents: { id: contentsId, send },
    isDestroyed: () => false,
  };
  return { win: win as unknown as Parameters<PreviewCompositor['compositeFrame']>[1], send };
}

/** Lengths of every `preview:frame` buffer a fake window received. */
function frameLengths(send: ReturnType<typeof vi.fn>): number[] {
  return send.mock.calls
    .filter((call) => call[0] === 'preview:frame')
    .map((call) => (call[1] as Buffer).length);
}

/** A project whose single video clip forces a (mocked) decoder round-trip. */
function projectWithVideoClip(): Project {
  const project = createEmptyProject();
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

describe('per-session preview compositors (#137 Slice 3)', () => {
  it('keys compositor instances by session id and drops them on dispose', () => {
    const first = getPreviewCompositorFor('reg-a');
    expect(getPreviewCompositorFor('reg-a')).toBe(first);
    const other = getPreviewCompositorFor('reg-b');
    expect(other).not.toBe(first);

    disposePreviewCompositor('reg-a');
    expect(getPreviewCompositorFor('reg-a')).not.toBe(first);
    disposePreviewCompositor('reg-a');
    disposePreviewCompositor('reg-b');
  });

  it('composites each session from that session’s own project', async () => {
    const a = getPreviewCompositorFor('own-a');
    const b = getPreviewCompositorFor('own-b');
    const projectA = createEmptyProject(); // 1920x1080 default canvas
    const projectB = createEmptyProject();
    projectB.settings.width = 640;
    projectB.settings.height = 360;
    a.setProject(projectA);
    b.setProject(projectB);
    const { win: winA, send: sendA } = fakeWin(31);
    const { win: winB, send: sendB } = fakeWin(32);

    await a.compositeFrame(0, winA);
    await b.compositeFrame(0, winB);

    expect(frameLengths(sendA)).toEqual([1920 * 1080 * 4]);
    expect(frameLengths(sendB)).toEqual([640 * 360 * 4]);
    disposePreviewCompositor('own-a');
    disposePreviewCompositor('own-b');
  });

  it('drops an in-flight frame only when its own session replaces the project', async () => {
    const a = getPreviewCompositorFor('inval-a');
    a.setProject(createEmptyProject());
    const { win: winA, send: sendA } = fakeWin(41);

    const run = a.compositeFrame(0, winA);
    // The session's own subsequent write mints a new project object, so the
    // stale in-flight frame must not publish over it.
    a.setProject(createEmptyProject());
    await run;

    expect(frameLengths(sendA)).toHaveLength(0);
    disposePreviewCompositor('inval-a');
  });

  it('keeps one session’s in-flight frame alive when another session sets its project', async () => {
    const a = getPreviewCompositorFor('keep-a');
    const b = getPreviewCompositorFor('keep-b');
    a.setProject(createEmptyProject());
    b.setProject(createEmptyProject());
    const { win: winA, send: sendA } = fakeWin(51);

    const runA = a.compositeFrame(0, winA);
    // B's own edit must not invalidate A's request (the shared-instance bug).
    b.setProject(createEmptyProject());
    await runA;

    expect(frameLengths(sendA)).toHaveLength(1);
    disposePreviewCompositor('keep-a');
    disposePreviewCompositor('keep-b');
  });

  it('delivers a late frame only to the window that asked, never another session’s', async () => {
    const a = getPreviewCompositorFor('late-a');
    const b = getPreviewCompositorFor('late-b');
    a.setProject(projectWithVideoClip()); // blocks on the mocked decoder
    const projectB = createEmptyProject();
    projectB.settings.width = 640;
    projectB.settings.height = 360;
    b.setProject(projectB);
    const { win: winA, send: sendA } = fakeWin(61);
    const { win: winB, send: sendB } = fakeWin(62);

    const runA = a.compositeFrame(0, winA);
    expect(decodeWaiters).toHaveLength(1); // A is genuinely in flight

    const runB = b.compositeFrame(0, winB);
    await runB;
    expect(frameLengths(sendB)).toEqual([640 * 360 * 4]);
    expect(frameLengths(sendA)).toHaveLength(0); // A's decode still pending

    // A's frame finishes late — it lands on A's window only. The mock's
    // getFrame parked this resolve; calling it delivers the decoded frame.
    decodeWaiters.shift()!({
      assetPath: 'C:/media/clip.mp4',
      sourceSeconds: 0,
      width: 64,
      height: 64,
      data: Buffer.alloc(64 * 64 * 4, 96),
      decodedAt: Date.now(),
    });
    await runA;
    // A's frame is the no-addon fallback (this file never loads one): the
    // decoded layer on the session's own 1920x1080 canvas. It used to publish
    // the 64x64 layer buffer, which PreviewCanvas drops as mis-sized.
    expect(frameLengths(sendA)).toEqual([1920 * 1080 * 4]);
    expect(frameLengths(sendB)).toEqual([640 * 360 * 4]);
    disposePreviewCompositor('late-a');
    disposePreviewCompositor('late-b');
  });

  it('routes preview IPC to the requesting session’s compositor', async () => {
    const projectA = createEmptyProject(); // 1920x1080
    const projectB = createEmptyProject();
    projectB.settings.width = 640;
    projectB.settings.height = 360;
    registerPreviewHandlers((sender) => {
      if (sender.id === 1) return { sessionId: 'ipc-a', project: projectA };
      if (sender.id === 2) return { sessionId: 'ipc-b', project: projectB };
      return null;
    });
    const { win: winA, send: sendA } = fakeWin(1);
    const { win: winB, send: sendB } = fakeWin(2);
    fromWebContents.mockImplementation((wc: { id: number }) => (wc.id === 1 ? winA : winB));
    const composite = ipcHandlers.get('preview:composite-frame')!;

    // Overlapping requests from both sessions: each must composite its own
    // project into its own window. On the Slice 1 shared instance, B's
    // setProject here invalidated A's request and winA received nothing.
    const runA = composite({ sender: { id: 1 } }, 0, []);
    const runB = composite({ sender: { id: 2 } }, 0, []);
    await Promise.all([runA, runB]);

    expect(frameLengths(sendA)).toEqual([1920 * 1080 * 4]);
    expect(frameLengths(sendB)).toEqual([640 * 360 * 4]);
    disposePreviewCompositor('ipc-a');
    disposePreviewCompositor('ipc-b');
  });
});
