/**
 * Media probing via ffprobe — pure main-process utility, no Electron.
 *
 * Split out of ipc/media.ts so non-IPC consumers (the generation importer in
 * the Agent executor) can use it without pulling Electron into unit tests.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';

const execFileAsync = promisify(execFile);

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

export async function probeMedia(filePath: string): Promise<MediaProbeResult> {
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
