/**
 * RGBA → PNG encoding for inspect_frame (#565).
 *
 * The frame decoder produces raw RGBA; FFmpeg reads it from stdin as a
 * single-frame rawvideo stream and encodes to PNG on disk. No native image
 * library is added for one encode.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';

const execFileAsync = promisify(execFile);

export async function rgbaToPng(
  rgba: Buffer,
  width: number,
  height: number,
  outputPath: string,
): Promise<void> {
  // File-based handoff: piping ~1MB into ffmpeg via stdin proved flaky on
  // Windows (sporadic EPIPE counted as conversion failure).
  const rawPath = `${outputPath}.rgba`;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(rawPath, rgba);
  try {
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'rawvideo',
      '-pix_fmt', 'rgba',
      '-s', `${width}x${height}`,
      '-r', '1',
      '-i', rawPath,
      '-frames:v', '1',
      outputPath,
    ], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  } finally {
    await fs.rm(rawPath, { force: true });
  }
}

/** Default output location: userData/inspect-frames/<name>.png */
export function inspectFramePath(userDataDir: string, hash: string): string {
  return path.join(userDataDir, 'inspect-frames', `${hash}.png`);
}
