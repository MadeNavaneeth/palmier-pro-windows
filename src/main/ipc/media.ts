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

const execFileAsync = promisify(execFile);

const MEDIA_FILTERS = [
  { name: 'Video', extensions: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv'] },
  { name: 'Audio', extensions: ['mp3', 'wav', 'aac', 'ogg', 'flac', 'm4a'] },
  { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] },
  { name: 'All Media', extensions: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'mp3', 'wav', 'aac', 'ogg', 'flac', 'm4a', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] },
];
const SUPPORTED_MEDIA_EXTENSIONS = new Set(
  MEDIA_FILTERS[MEDIA_FILTERS.length - 1].extensions.map((extension) => `.${extension}`),
);

export interface MediaProbeResult {
  path: string;
  filename: string;
  duration: number; // seconds
  width?: number;
  height?: number;
  fps?: number;
  codec?: string;
  audioCodec?: string;
  sampleRate?: number;
  channels?: number;
  fileSize: number;
  type: 'video' | 'audio' | 'image';
}

export function registerMediaHandlers(): void {
  // ─── Import Media (open file dialog) ─────────────────────────────────────────
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

  // ─── Probe single file ───────────────────────────────────────────────────────
  ipcMain.handle('media:probe', async (_event, filePath: string) => {
    try {
      const info = await probeMedia(filePath);
      return { success: true, info };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // ─── Generate thumbnail ──────────────────────────────────────────────────────
  ipcMain.handle('media:thumbnail', async (_event, filePath: string, outputDir: string, timestamp: number = 1) => {
    try {
      const thumbPath = await generateThumbnail(filePath, outputDir, timestamp);
      return { success: true, path: thumbPath };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // ─── Offline check: which asset paths no longer exist on disk ────────────────
  ipcMain.handle('media:check-offline', async (_event, paths: unknown) => {
    if (!Array.isArray(paths)) return { missing: [] };
    const missing = paths.filter(
      (p): p is string => typeof p === 'string' && p.length > 0 && !fsSync.existsSync(p),
    );
    return { missing };
  });

  // ─── Extract audio from a video into a library asset (upstream PR #562) ─────
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
  const probed: MediaProbeResult[] = [];
  const errors: string[] = [];

  for (const filePath of [...new Set(filePaths)]) {
    if (!SUPPORTED_MEDIA_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
      errors.push(`${path.basename(filePath)} is not a supported media file`);
      continue;
    }

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

// ─── ffprobe wrapper ─────────────────────────────────────────────────────────

async function probeMedia(filePath: string): Promise<MediaProbeResult> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ]);

  const data = JSON.parse(stdout);
  const format = data.format;
  const videoStream = data.streams?.find((s: any) => s.codec_type === 'video');
  const audioStream = data.streams?.find((s: any) => s.codec_type === 'audio');

  const ext = path.extname(filePath).toLowerCase();
  const imageExts = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'];
  const audioExts = ['.mp3', '.wav', '.aac', '.ogg', '.flac', '.m4a'];

  let type: 'video' | 'audio' | 'image' = 'video';
  if (imageExts.includes(ext)) type = 'image';
  else if (audioExts.includes(ext) || (!videoStream && audioStream)) type = 'audio';

  const fpsStr = videoStream?.r_frame_rate || '0/1';
  const [num, den] = fpsStr.split('/').map(Number);
  const fps = den ? num / den : 0;

  const stat = await fs.stat(filePath);

  return {
    path: filePath,
    filename: path.basename(filePath),
    duration: parseFloat(format.duration) || 0,
    width: videoStream ? parseInt(videoStream.width) : undefined,
    height: videoStream ? parseInt(videoStream.height) : undefined,
    fps: fps > 0 ? Math.round(fps * 100) / 100 : undefined,
    codec: videoStream?.codec_name,
    audioCodec: audioStream?.codec_name,
    sampleRate: audioStream ? parseInt(audioStream.sample_rate) : undefined,
    channels: audioStream?.channels,
    fileSize: stat.size,
    type,
  };
}

// ─── Thumbnail generation ────────────────────────────────────────────────────

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
