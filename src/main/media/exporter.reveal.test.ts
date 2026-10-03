/**
 * `export:reveal` failure reporting.
 *
 * `shell.showItemInFolder` is fire-and-forget in Electron — it posts to a
 * worker thread and returns nothing — so the handler cannot observe a failure
 * inside the shell and used to answer `{ success: true }` for every path. A
 * reveal that never happened read as one that did.
 *
 * What the handler CAN know is whether the shell could resolve the containing
 * directory: Node stats it through the same filesystem Explorer reads, so a
 * directory that cannot be opened here is one the shell cannot parse either.
 * That is what this pins, at the handler's own branch, driven through the
 * registered `ipcMain` listener (the seam `exporter.session.test.ts` uses).
 *
 * Not pinned, and not detectable through this API: a shell-side rejection of a
 * directory that resolves fine. `showItemInFolder` drops that on the floor.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import { promises as fsp } from 'fs';
import { registerExportHandlers } from './exporter';

/** One registered `ipcMain` listener: (event, outputPath) -> its answer. */
type RevealHandler = (event: unknown, outputPath: unknown) => unknown;

const { ipcHandlers, showItemInFolder } = vi.hoisted(() => {
  const ipcHandlers = new Map<string, RevealHandler>();
  const showItemInFolder = vi.fn();
  return { ipcHandlers, showItemInFolder };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, listener: RevealHandler) => {
      ipcHandlers.set(channel, listener);
    },
  },
  BrowserWindow: { fromWebContents: () => null },
  shell: { showItemInFolder },
  dialog: { showSaveDialog: async () => ({ canceled: true }) },
  app: { getPath: () => '' },
  default: {},
}));

const TMP = path.join(os.tmpdir(), `palmier-exporter-reveal-${process.pid}`);
const DELIVERED = path.join(TMP, 'out.mp4');
const UNREACHABLE = path.join(TMP, 'not-a-directory', 'out.mp4');

function reveal(outputPath: unknown) {
  return ipcHandlers.get('export:reveal')!({ sender: { id: 1 } }, outputPath);
}

beforeAll(async () => {
  await fsp.mkdir(TMP, { recursive: true });
});

afterAll(async () => {
  await fsp.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

beforeEach(() => {
  ipcHandlers.clear();
  showItemInFolder.mockReset();
  registerExportHandlers(() => null);
});

describe('export:reveal reports a reveal it could not perform', () => {
  it('reports the directory it could not open instead of a success', async () => {
    const res = await reveal(UNREACHABLE) as { success: boolean; error?: string };

    expect(res.success).toBe(false);
    // Names the directory, so the user can tell which delivery is unreachable.
    expect(res.error).toContain(path.dirname(UNREACHABLE));
    // Nothing was handed to the shell: there was no folder to reveal into.
    expect(showItemInFolder).not.toHaveBeenCalled();
  });

  it('reveals and answers success when the directory opens', async () => {
    expect(await reveal(DELIVERED)).toEqual({ success: true });
    expect(showItemInFolder).toHaveBeenCalledWith(DELIVERED);
  });

  it('answers success without calling the shell for a non-path', async () => {
    // Unchanged: nothing was asked for, so nothing failed.
    expect(await reveal('')).toEqual({ success: true });
    expect(showItemInFolder).not.toHaveBeenCalled();
  });
});
