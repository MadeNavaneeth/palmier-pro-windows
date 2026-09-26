/**
 * Proxy generation (roadmap R2): background 540p mezzanine transcodes.
 *
 * Generation state is deliberately NOT persisted and NOT part of undo —
 * only the final attach (controller.setProxyState) is an editor command.
 * A crash mid-generation leaves no proxy field behind, so nothing can
 * reference a half-written file; the next Generate attempt starts fresh
 * because the output path is content-keyed by source mtime.
 */

import { spawn } from 'child_process';
import { app, ipcMain } from 'electron';
import path from 'path';
import fsSync from 'fs';
import crypto from 'crypto';
import type { EditorController } from '../../shared/editor/controller';
import { NO_SESSION_ERROR, type SessionSender } from '../sessions';
import { proxyArgs, PROXY_CRF, PROXY_WIDTH_CAP } from '../../shared/media/proxy';

/**
 * Bumped whenever the proxy transcode recipe changes, so the content-keyed
 * output path changes with it and stale narrow/blurry proxies regenerate.
 */
const PROXY_POLICY_VERSION = `v2-cap${PROXY_WIDTH_CAP}-crf${PROXY_CRF}`;
import { loadProxyMode, saveProxyMode } from './proxy-mode';

const generating = new Set<string>();

function proxyOutputPath(sourcePath: string, userDataDir: string): string {
  const stat = fsSync.statSync(sourcePath);
  // The proxy POLICY version is part of the key: when the transcode recipe
  // changes (upstream #573 raised width cap 960→1920 and CRF 26→20), assets
  // with an old-generation proxy must regenerate instead of serving the
  // blurry narrow file forever. Bump PROXY_POLICY_VERSION with any change
  // to PROXY_WIDTH_CAP, PROXY_CRF, or the FFmpeg argument shape.
  const key = crypto
    .createHash('sha1')
    .update(`${PROXY_POLICY_VERSION}|${sourcePath}|${stat.size}|${stat.mtimeMs}`)
    .digest('hex')
    .slice(0, 16);
  return path.join(userDataDir, 'proxies', `${key}.mp4`);
}

/**
 * Proxy IPC. `getController` resolves the requesting session's controller
 * (#137): reads (project lookup) and the finishing `setProxyState` edit both
 * belong to the window that started the job. The content-keyed output files
 * and the shared proxy-mode preference stay process-wide by design.
 */
export function registerProxyHandlers(
  getController: (sender: SessionSender) => EditorController | null,
): void {
  ipcMain.handle('media:generate-proxy', async (event, assetId: unknown) => {
    if (typeof assetId !== 'string') return { success: false, error: 'Invalid asset id' };
    const editorController = getController(event.sender);
    if (!editorController) return { success: false, error: NO_SESSION_ERROR };
    const project = editorController.getProject();
    const asset = project.media.find((a) => a.id === assetId);
    if (!asset) return { success: false, error: `No media asset "${assetId}".` };
    if (asset.type !== 'video') {
      return { success: false, error: 'Only video assets need proxies.' };
    }
    if (asset.proxyPath && fsSync.existsSync(asset.proxyPath)) {
      return { success: true, alreadyReady: true };
    }
    if (generating.has(assetId)) return { success: true, alreadyGenerating: true };

    let outPath: string;
    try {
      outPath = proxyOutputPath(asset.path, app.getPath('userData'));
      fsSync.mkdirSync(path.dirname(outPath), { recursive: true });
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    generating.add(assetId);
    const proc = spawn('ffmpeg', proxyArgs(asset.path, outPath), {
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
    });
    proc.on('close', (code) => {
      generating.delete(assetId);
      if (code === 0 && fsSync.existsSync(outPath) && fsSync.statSync(outPath).size > 0) {
        // The only editorial mutation: attaching the finished proxy.
        editorController.setProxyState(assetId, outPath);
      }
      // Failures stay silent here by design -- the panel badge simply never
      // appears, and the user can retry from the same menu item.
    });

    return { success: true, started: true };
  });

  ipcMain.handle('media:proxy-status', () => ({ generating: [...generating] }));

  ipcMain.handle('media:get-proxy-mode', () => loadProxyMode());
  ipcMain.handle('media:set-proxy-mode', (_event, mode: unknown) => {
    if (mode !== 'auto' && mode !== 'off') {
      return { success: false, error: 'Proxy mode must be auto or off.' };
    }
    return { success: true, mode: saveProxyMode(mode) };
  });

  ipcMain.handle(
    'media:remove-proxy',
    async (event, assetId: unknown) => {
      if (typeof assetId !== 'string') return { success: false };
      const editorController = getController(event.sender);
      if (!editorController) return { success: false, error: NO_SESSION_ERROR };
      const project = editorController.getProject();
      const asset = project.media.find((a) => a.id === assetId);
      if (!asset?.proxyPath) return { success: true };
      try {
        fsSync.rmSync(asset.proxyPath, { force: true });
      } catch {
        // A locked or already-deleted proxy file must not block detaching.
      }
      editorController.setProxyState(assetId, null);
      return { success: true };
    },
  );
}
