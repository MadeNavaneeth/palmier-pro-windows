/**
 * IPC handlers for media operations.
 * Uses ffprobe for metadata extraction and thumbnail generation.
 */

import { ipcMain, dialog, BrowserWindow, app } from 'electron';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
import crypto from 'crypto';
import { loadPresets, savePresets } from '../media/export-presets';
import { expandImportPaths } from '../media/import-expansion';
// Probe lives in ../media/probe (electron-free) so the Agent executor can
// import it without pulling Electron into unit tests.
import { probeMedia } from '../media/probe';
import { getTranscribeConfig, setTranscribeConfig } from '../media/transcribe-config';
import { parseFcpxml } from '../../shared/fcpxml/importer';
import type { MediaProbeResult } from '../media/probe';
export { probeMedia };
export type { MediaProbeResult };

const execFileAsync = promisify(execFile);

const MEDIA_FILTERS = [
  { name: 'Video', extensions: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv'] },
  { name: 'Audio', extensions: ['mp3', 'wav', 'aac', 'ogg', 'flac', 'm4a'] },
  { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] },
  { name: 'All Media', extensions: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'mp3', 'wav', 'aac', 'ogg', 'flac', 'm4a', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] },
];


export function registerMediaHandlers(): void {
  // â”€â”€â”€ Import Media (open file dialog) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  ipcMain.handle('media:import', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(win!, {
      title: 'Import Media',
      filters: MEDIA_FILTERS,
      properties: ['openFile', 'multiSelections'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, files: [] };
    }

    return probeMediaPaths(result.filePaths);
  });

  // Import paths supplied by an operating-system file drop in the renderer.
  ipcMain.handle('media:import-paths', async (_event, filePaths: unknown) => {
    if (!Array.isArray(filePaths)) {
      return { success: false, files: [], errors: ['Invalid file list'] };
    }

    const safePaths = filePaths
      .filter((filePath): filePath is string => typeof filePath === 'string')
      .slice(0, 100);

    return probeMediaPaths(safePaths);
  });

  // â”€â”€â”€ Probe single file â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  ipcMain.handle('media:probe', async (_event, filePath: string) => {
    try {
      const info = await probeMedia(filePath);
      return { success: true, info };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // â”€â”€â”€ Generate thumbnail â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  ipcMain.handle('media:thumbnail', async (_event, filePath: string, outputDir: string, timestamp: number = 1) => {
    try {
      const thumbPath = await generateThumbnail(filePath, outputDir, timestamp);
      return { success: true, path: thumbPath };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // â”€â”€â”€ Export presets (R2) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  ipcMain.handle('export:get-presets', () => {
    return { success: true, presets: loadPresets() };
  });
  ipcMain.handle('export:set-presets', (_event, presets: unknown) => {
    if (!Array.isArray(presets)) return { success: false };
    savePresets(presets as ReturnType<typeof loadPresets>);
    return { success: true };
  });

  // â”€â”€â”€ Offline check: which asset paths no longer exist on disk â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  ipcMain.handle('media:check-offline', async (_event, paths: unknown) => {
    if (!Array.isArray(paths)) return { missing: [] };
    const missing = paths.filter(
      (p): p is string => typeof p === 'string' && p.length > 0 && !fsSync.existsSync(p),
    );
    return { missing };
  });

  // ─── FCPXML import/export UI bridges (#154) ──────────────────────────────
  // Open + parse + probe in one step; the renderer applies the returned plan
  // to its own controller via shared/fcpxml/apply.ts.
  ipcMain.handle('media:fcpxml-open', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(win!, {
      title: 'Import Final Cut XML',
      filters: [{ name: 'Final Cut XML', extensions: ['fcpxml', 'xml'] }],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) return { success: false, canceled: true };

    try {
      const xml = await fs.readFile(result.filePaths[0], 'utf8');
      const plan = parseFcpxml(xml);
      if (!plan.fps) {
        return { success: false, error: 'The file has no usable <format frameDuration>.' };
      }
      // Probe every unique asset up front so the renderer gets library ids.
      const assets = [];
      for (const entry of plan.assets) {
        let assetId: string | null = null;
        let probe: MediaProbeResult | null = null;
        if (fsSync.existsSync(entry.path)) {
          try {
            probe = await probeMedia(entry.path);
            assetId = crypto.randomUUID();
          } catch { /* falls through as offline */ }
        }
        assets.push({ ...entry, assetId, probe });
      }
      return { success: true, plan, assets };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Save-dialog + write; the renderer generates the XML from its live project.
  ipcMain.handle('media:fcpxml-write', async (_event, payload: unknown) => {
    const xml = (payload as { xml?: unknown } | null)?.xml;
    if (typeof xml !== 'string' || xml.length === 0) {
      return { success: false, error: 'Nothing to write.' };
    }
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showSaveDialog(win!, {
      title: 'Export Final Cut XML',
      defaultPath: 'timeline.fcpxml',
      filters: [{ name: 'Final Cut XML', extensions: ['fcpxml'] }],
    });
    if (result.canceled || !result.filePath) return { success: false, canceled: true };
    await fs.writeFile(result.filePath, xml, 'utf8');
    return { success: true, path: result.filePath };
  });


  // â”€â”€â”€ Filmstrip: evenly spaced thumbnails across a video source (R1) â”€â”€â”€â”€â”€â”€â”€â”€â”€
  ipcMain.handle('media:filmstrip', async (_event, filePath: unknown, count: unknown) => {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      return { success: false, error: 'Invalid source path' };
    }
    const frames = Math.min(12, Math.max(2, Math.floor(Number(count)) || 6));
    try {
      const stat = await fs.stat(filePath);
      const key = crypto
        .createHash('sha1')
        .update(`${filePath}|${stat.size}|${stat.mtimeMs}|${frames}`)
        .digest('hex')
        .slice(0, 16);
      const dir = path.join(app.getPath('userData'), 'filmstrips', key);
      // Cached strips survive restarts; a complete strip short-circuits.
      const existing = await Promise.all(
        Array.from({ length: frames }, (_, i) =>
          fs.access(path.join(dir, `${i}.jpg`)).then(() => true).catch(() => false),
        ),
      );
      if (existing.every(Boolean)) {
        return {
          success: true,
          paths: existing.map((_, i) => path.join(dir, `${i}.jpg`)),
        };
      }
      await fs.mkdir(dir, { recursive: true });

      const probe = await probeMedia(filePath);
      const totalSec = Math.max(0.04, probe.duration || 0);
      for (let i = 0; i < frames; i += 1) {
        const at = ((i + 0.5) / frames) * totalSec;
        const out = path.join(dir, `${i}.jpg`);
        try {
          await execFileAsync('ffmpeg', [
            '-y', '-ss', at.toFixed(3), '-i', filePath,
            '-frames:v', '1', '-vf', 'scale=96:-2', '-q:v', '6', out,
          ]);
        } catch {
          // A single failed sample just leaves a gap in the strip.
        }
      }
      const paths = Array.from({ length: frames }, (_, i) => path.join(dir, `${i}.jpg`));
      const present = await Promise.all(paths.map((p) => fileExists(p)));
      if (!present.some(Boolean)) {
        return { success: false, error: 'Filmstrip generation produced no frames.' };
      }
      return { success: true, paths };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  // â”€â”€â”€ Hardware encoder detection (R2) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  let hwEncoderCache: string[] | null = null;
  ipcMain.handle('media:hw-encoders', async () => {
    if (hwEncoderCache) return { encoders: hwEncoderCache };
    const encoders = await new Promise<string[]>((resolve) => {
      execFile('ffmpeg', ['-hide_banner', '-encoders'], (err, stdout) => {
        if (err) {
          resolve([]);
          return;
        }
        const found: string[] = [];
        // Preference order: discrete NVENC, then Intel QSV, then AMD AMF.
        for (const name of ['h264_nvenc', 'h264_qsv', 'h264_amf']) {
          if (stdout.includes(name)) found.push(name.replace('h264_', ''));
        }
        resolve(found);
      });
    });
    hwEncoderCache = encoders;
    return { encoders };
  });

  // â”€â”€â”€ Folder picker â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  ipcMain.handle('media:choose-folder', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(win!, {
      title: 'Choose a folder to scan for media',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return { success: false, folder: '' };
    return { success: true, folder: result.filePaths[0] };
  });

  /**
   * Offline-relink scan (upstream EditorViewModel+Relink): walk `folder`
   * recursively and match each given filename case-insensitively, first
   * match wins. Bounded walk so a huge tree cannot hang the main process.
   */
  // ─── Caption transcription (#39/#91) ─────────────────────────────────────
  // Custom STT server preference (#287): read for the form, write on save.
  ipcMain.handle('media:get-transcribe-config', () => {
    return { success: true, config: getTranscribeConfig() };
  });
  ipcMain.handle('media:set-transcribe-config', (_event, patch: unknown) => {
    return { success: true, config: setTranscribeConfig((patch ?? {}) as Record<string, string>) };
  });

  // Electron-bound runtime resolution (decrypted AI provider keys) + the
  // pure transport + planner run here; the returned cue plan is materialized
  // by the renderer onto its own controller via shared/captions/apply.ts.
  ipcMain.handle('media:transcribe', async (_event, payload: unknown) => {
    const req = (payload ?? {}) as { path?: unknown; language?: unknown; model?: unknown };
    if (typeof req.path !== 'string' || req.path.length === 0) {
      return { success: false, error: 'No asset selected.' };
    }
    const { getOpenAiCompatibleRuntime } = await import('../ai/ipc');
    const { getTranscribeConfig } = await import('../media/transcribe-config');
    const override = getTranscribeConfig();
    const runtime =
      override.baseUrl && override.apiKey
        ? { baseUrl: override.baseUrl, apiKey: override.apiKey }
        : getOpenAiCompatibleRuntime();
    if (!runtime) {
      return {
        success: false,
        error: 'No transcription endpoint configured. Add an AI provider key, or set a custom server in the Captions tab.',
      };
    }
    const model = typeof req.model === 'string' && req.model.trim() ? req.model.trim() : undefined;
    try {
      const { transcribeAudio } = await import('../ai/transcribe');
      const transcription = await transcribeAudio(runtime, req.path, {
        model: model ?? (override.baseUrl ? override.model : undefined),
        language: typeof req.language === 'string' && req.language.trim() ? req.language.trim() : undefined,
      });
      const { planCaptions } = await import('../../shared/captions/planner');
      const cues = planCaptions(transcription.words);
      return {
        success: true,
        cues,
        words: transcription.words.length,
        text: transcription.text,
        model: transcription.model,
      };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle('media:scan-relink', async (_event, filenames: unknown, folder: unknown) => {
    if (!Array.isArray(filenames) || typeof folder !== 'string' || folder.length === 0) {
      return { success: false, error: 'Invalid scan request', matches: {} };
    }
    const index = new Map<string, string>();
    let visited = 0;
    const MAX_ENTRIES = 20_000;
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 8 || visited > MAX_ENTRIES) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        visited += 1;
        if (visited > MAX_ENTRIES) return;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full, depth + 1);
        else if (entry.isFile()) {
          const key = entry.name.toLowerCase();
          if (!index.has(key)) index.set(key, full);
        }
      }
    };
    await walk(folder, 0);

    const matches: Record<string, string> = {};
    for (const raw of filenames) {
      if (typeof raw !== 'string' || raw.length === 0) continue;
      const hit = index.get(raw.toLowerCase());
      if (hit) matches[raw] = hit;
    }
    return { success: true, matches };
  });


  // â”€â”€â”€ Extract audio from a video into a library asset (upstream PR #562) â”€â”€â”€â”€â”€
  // An optional `window` bakes a source range into the extracted file, which
  // is how the timeline clip entry ("Save as audio") captures the clip's
  // trim; omitted, the full source is extracted (media-panel entry).
  ipcMain.handle('media:extract-audio', async (_event, sourcePath: unknown, window?: unknown) => {
    if (typeof sourcePath !== 'string' || sourcePath.length === 0) {
      return { success: false, error: 'Invalid source path' };
    }
    let startSec: number | undefined;
    let endSec: number | undefined;
    if (window !== undefined && window !== null) {
      const w = window as { startSec?: unknown; endSec?: unknown };
      startSec = typeof w.startSec === 'number' ? w.startSec : NaN;
      endSec = typeof w.endSec === 'number' ? w.endSec : NaN;
      if (
        !Number.isFinite(startSec) || !Number.isFinite(endSec)
        || startSec < 0 || endSec <= startSec
      ) {
        return { success: false, error: 'Invalid extraction window' };
      }
    }
    try {
      // Eligibility is decided before any FFmpeg work: the source must carry
      // an audio stream, mirroring upstream's `canExtractAudio` gate.
      const probe = await probeMedia(sourcePath);
      if (!probe.audioCodec) {
        return { success: false, error: `${probe.filename} has no audio stream` };
      }

      const outputDir = path.join(app.getPath('userData'), 'extracted-audio');
      await fs.mkdir(outputDir, { recursive: true });
      const base = path.basename(sourcePath, path.extname(sourcePath));
      let outputPath = path.join(outputDir, `${base} (audio).m4a`);
      for (let n = 2; await fileExists(outputPath); n += 1) {
        outputPath = path.join(outputDir, `${base} (audio) ${n}.m4a`);
      }

      try {
        // Output-side seeking: decode-then-trim is sample-accurate for a
        // re-encode and needs no keyframe alignment.
        const ffmpegArgs = ['-y'];
        ffmpegArgs.push('-i', sourcePath);
        if (startSec !== undefined && endSec !== undefined) {
          ffmpegArgs.push('-ss', startSec.toFixed(4), '-to', endSec.toFixed(4));
        }
        ffmpegArgs.push('-vn', '-c:a', 'aac', '-b:a', '192k', outputPath);
        await execFileAsync('ffmpeg', ffmpegArgs);
      } catch (err: unknown) {
        // A failed extraction must not leave a partial file behind to be
        // imported later as a broken asset.
        await fs.rm(outputPath, { force: true });
        throw err;
      }

      const extracted = await probeMedia(outputPath);
      return { success: true, asset: extracted };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function probeMediaPaths(filePaths: string[]): Promise<{
  success: boolean;
  files: MediaProbeResult[];
  errors: string[];
}> {
  // Folders expand here (upstream #453): a dropped directory imports the
  // media inside instead of being refused as "not a supported media file",
  // and every skipped top-level item comes back with a readable reason.
  const { files: mediaFiles, errors } = await expandImportPaths(filePaths);
  const probed: MediaProbeResult[] = [];

  for (const filePath of mediaFiles) {
    try {
      probed.push(await probeMedia(filePath));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Failed to probe ${filePath}:`, message);
      errors.push(`Could not import ${path.basename(filePath)}`);
    }
  }

  return { success: probed.length > 0, files: probed, errors };
}


// â”€â”€â”€ Thumbnail generation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function generateThumbnail(
  filePath: string,
  outputDir: string,
  timestamp: number,
): Promise<string> {
  const basename = path.basename(filePath, path.extname(filePath));
  const thumbName = `${basename}_thumb.jpg`;
  const thumbPath = path.join(outputDir, thumbName);

  await fs.mkdir(outputDir, { recursive: true });

  await execFileAsync('ffmpeg', [
    '-y',
    '-ss', String(timestamp),
    '-i', filePath,
    '-vframes', '1',
    '-vf', 'scale=320:-1',
    '-q:v', '5',
    thumbPath,
  ]);

  return thumbPath;
}





