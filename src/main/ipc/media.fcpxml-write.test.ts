/**
 * The FCPXML write path end to end (#154).
 *
 * The exporter's omission report is only useful if it survives every hop. This
 * drives the real exporter, the real preload bridge, and the real main-process
 * handler — the same three the export panel uses — and asserts the notes come
 * back out of the write so the panel can report them.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import type { Project } from '../../shared/types/project';
import type { PalmierAPI } from '../../preload/index';
import { summarizeXmlOmissions } from '../../renderer/components/ExportDialog';

type MockHandler = (
  event: { sender: { id: number } },
  ...args: unknown[]
) => Promise<unknown>;

type WriteResult = {
  success: boolean;
  path?: string;
  error?: string;
  canceled?: boolean;
  unsupported?: string[];
};

const electronState = vi.hoisted(() => ({
  handlers: new Map<string, MockHandler>(),
  invocations: [] as unknown[][],
  exposed: new Map<string, unknown>(),
  savePath: '',
  canceled: false,
  userData: '',
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: MockHandler) => {
      electronState.handlers.set(channel, handler);
    },
  },
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => {
      electronState.invocations.push([channel, ...args]);
      const handler = electronState.handlers.get(channel);
      if (!handler) throw new Error(`Missing handler: ${channel}`);
      return handler({ sender: { id: 1 } }, ...args);
    },
  },
  contextBridge: {
    exposeInMainWorld: (key: string, api: unknown) => {
      electronState.exposed.set(key, api);
    },
  },
  dialog: {
    showSaveDialog: async () => (electronState.canceled
      ? { canceled: true, filePath: undefined }
      : { canceled: false, filePath: electronState.savePath }),
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  },
  BrowserWindow: { getFocusedWindow: () => ({ id: 1 }) },
  app: { getPath: () => electronState.userData },
  webUtils: { getPathForFile: () => '' },
}));

const { registerMediaHandlers } = await import('./media');
const { exportFcpxmlWithReport } = await import('../../shared/fcpxml/exporter');
// Importing the preload runs its `contextBridge.exposeInMainWorld` call, which
// is where the renderer-facing bridge is built.
await import('../../preload/index');

const api = electronState.exposed.get('palmier') as PalmierAPI;

const VIDEO_PATH = 'X:/media/clip.mp4';

function projectWith(clips: Array<Record<string, unknown>>): Project {
  return {
    version: 2,
    name: 'Bridge Fixture',
    settings: { width: 1920, height: 1080, fps: 30, sampleRate: 48000, backgroundColor: '#000000' },
    media: [{
      id: 'v', path: VIDEO_PATH, filename: 'clip.mp4', type: 'video', duration: 600,
      width: 1920, height: 1080, fileSize: 1, addedAt: '2026-01-01T00:00:00.000Z',
    }],
    timeline: {
      tracks: [{ id: 'v1', name: 'Video 1', type: 'video', locked: false, visible: true, syncLocked: true, order: 0 }],
      clips: clips.map((clip, index) => ({
        id: `c${index}`, assetId: 'v', label: 'Clip', trackId: 'v1', type: 'video',
        startFrame: index * 60, durationFrames: 60, inPoint: 0, outPoint: 60,
        x: 0, y: 0, width: 1920, height: 1080, rotation: 0, scaleX: 1, scaleY: 1,
        opacity: 1, anchorX: 0, anchorY: 0, volume: 1, muted: false,
        ...clip,
      })) as unknown as Project['timeline']['clips'],
      playheadFrame: 0,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as unknown as Project;
}

const scratchDirs: string[] = [];

beforeAll(() => {
  registerMediaHandlers();
});

beforeEach(async () => {
  electronState.invocations.length = 0;
  electronState.canceled = false;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palmier-fcpxml-write-'));
  scratchDirs.push(dir);
  electronState.userData = dir;
  electronState.savePath = path.join(dir, 'timeline.fcpxml');
});

afterEach(async () => {
  while (scratchDirs.length > 0) {
    await fs.rm(scratchDirs.pop()!, { recursive: true, force: true });
  }
});

describe('media:fcpxml-write carries the omission report', () => {
  it('sends the exporter notes through the bridge and returns them with the path', async () => {
    const project = projectWith([
      { id: 'graded', brightness: 0.2, fadeInFrames: 12 },
      { id: 'shape-1', type: 'shape', shapeKind: 'rect' },
    ]);
    const report = exportFcpxmlWithReport(project);
    expect(report.unsupported).toHaveLength(3);

    const res = await api.media.writeFcpxml({
      xml: report.xml,
      unsupported: report.unsupported,
    }) as WriteResult;

    // The bridge sends the structured result, not only the XML body.
    expect(electronState.invocations[0]).toEqual([
      'media:fcpxml-write',
      { xml: report.xml, unsupported: report.unsupported },
    ]);
    expect(res.success).toBe(true);
    expect(res.path).toBe(electronState.savePath);
    expect(res.unsupported).toEqual(report.unsupported);
    // The file is unchanged by the report riding along.
    expect(await fs.readFile(res.path!, 'utf8')).toBe(report.xml);

    // And the notes that came back still group into the panel's notice.
    const summary = summarizeXmlOmissions(res.unsupported!);
    expect(summary.total).toBe(3);
    expect(summary.groups.map((group) => group.label)).toEqual([
      'color grade',
      'fades',
      'shape clips have no FCPXML form.',
    ]);
  });

  it('returns an empty report for a project with nothing unsupported', async () => {
    const report = exportFcpxmlWithReport(projectWith([{ id: 'plain' }]));
    expect(report.unsupported).toEqual([]);

    const res = await api.media.writeFcpxml({
      xml: report.xml,
      unsupported: report.unsupported,
    }) as WriteResult;

    expect(res).toEqual({ success: true, path: electronState.savePath, unsupported: [] });
    expect(await fs.readFile(res.path!, 'utf8')).toBe(report.xml);
  });

  it('narrows the notes it echoes and defaults an absent report to none', async () => {
    const xml = exportFcpxmlWithReport(projectWith([{ id: 'plain' }])).xml;

    const malformed = await api.media.writeFcpxml({
      xml,
      unsupported: ['Clip "c0" carries fades; FCPXML does not represent them.', 42, null, ''],
    } as never) as WriteResult;
    const absent = await api.media.writeFcpxml({ xml } as never) as WriteResult;
    const wrongType = await api.media.writeFcpxml({ xml, unsupported: 'nope' } as never) as WriteResult;

    expect(malformed.unsupported).toEqual(['Clip "c0" carries fades; FCPXML does not represent them.']);
    expect(absent.unsupported).toEqual([]);
    expect(wrongType.unsupported).toEqual([]);
  });

  it('still refuses an empty write and reports a canceled save', async () => {
    const empty = await api.media.writeFcpxml({ xml: '', unsupported: [] }) as WriteResult;
    expect(empty).toEqual({ success: false, error: 'Nothing to write.' });

    electronState.canceled = true;
    const canceled = await api.media.writeFcpxml({ xml: '<fcpxml/>', unsupported: [] }) as WriteResult;
    expect(canceled).toEqual({ success: false, canceled: true });
  });
});
