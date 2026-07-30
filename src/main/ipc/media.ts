/**
 * IPC handlers for media operations.
 * Uses ffprobe for metadata extraction and thumbnail generation.
 */

import { ipcMain, dialog, BrowserWindow } from 'electron';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';

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
