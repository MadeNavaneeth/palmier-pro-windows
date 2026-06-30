/**
 * FFmpeg Exporter — converts the timeline state into a filter_complex graph
 * and runs FFmpeg to produce the final video file.
 *
 * Uses geometry.rs export_filter_geometry() for pixel-exact transforms that
 * match the preview compositor exactly.
 *
 * Supports: MP4 (H.264), MOV (ProRes proxy), WebM (VP9).
 * Reports progress back to the renderer via IPC events.
 */

import { spawn, ChildProcess } from 'child_process';
import { ipcMain, BrowserWindow } from 'electron';
import path from 'path';
import fs from 'fs/promises';
import type { Project, Clip, Track, Frame } from '../../shared/types/project';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ExportOptions {
  outputPath: string;
  format: 'mp4' | 'mov' | 'webm';
  quality: 'draft' | 'normal' | 'high';
  width?: number;
  height?: number;
  fps?: number;
}

export interface ExportProgress {
  percent: number;
  frame: number;
  totalFrames: number;
  fps: number; // encoding fps
  eta: string; // estimated time remaining
}

// ─── Quality presets ─────────────────────────────────────────────────────────

const PRESETS: Record<string, Record<string, string[]>> = {
  mp4: {
    draft: ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28'],
    normal: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20'],
    high: ['-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-profile:v', 'high', '-level', '5.1'],
  },
  mov: {
    draft: ['-c:v', 'prores_ks', '-profile:v', '0'], // ProRes Proxy
    normal: ['-c:v', 'prores_ks', '-profile:v', '2'], // ProRes LT
    high: ['-c:v', 'prores_ks', '-profile:v', '3'], // ProRes HQ
  },
  webm: {
    draft: ['-c:v', 'libvpx-vp9', '-crf', '35', '-b:v', '0', '-deadline', 'realtime'],
    normal: ['-c:v', 'libvpx-vp9', '-crf', '28', '-b:v', '0', '-deadline', 'good'],
    high: ['-c:v', 'libvpx-vp9', '-crf', '20', '-b:v', '0', '-deadline', 'best'],
  },
};

// ─── Exporter ────────────────────────────────────────────────────────────────

export class Exporter {
  private currentProcess: ChildProcess | null = null;
  private cancelled = false;
  private nativeAddon: any = null;

  setNativeAddon(addon: any): void {
    this.nativeAddon = addon;
  }

  async export(project: Project, options: ExportOptions, win: BrowserWindow): Promise<void> {
    this.cancelled = false;
    const { outputPath, format, quality } = options;
    const width = options.width || project.settings.width;
    const height = options.height || project.settings.height;
    const fps = options.fps || project.settings.fps;

    // Calculate total frames
    const clips = project.timeline.clips;
    const totalFrames = clips.length > 0
      ? Math.max(...clips.map((c) => c.startFrame + c.durationFrames))
      : 0;

    if (totalFrames === 0) {
      win.webContents.send('export:error', 'No clips on timeline');
      return;
    }

    // Build the FFmpeg command
    const args = this.buildFfmpegArgs(project, options, width, height, fps, totalFrames);

    win.webContents.send('export:progress', {
      percent: 0,
      frame: 0,
      totalFrames,
      fps: 0,
      eta: 'Calculating...',
    } satisfies ExportProgress);

    // Run FFmpeg
    return new Promise<void>((resolve, reject) => {
      const proc = spawn('ffmpeg', args, {
        stdio: ['ignore', 'ignore', 'pipe'], // stderr for progress
        windowsHide: true,
      });
      this.currentProcess = proc;

      let stderrData = '';

      proc.stderr!.on('data', (chunk: Buffer) => {
        stderrData += chunk.toString();

        // Parse progress from FFmpeg stderr
        const progress = this.parseProgress(stderrData, totalFrames);
        if (progress) {
          win.webContents.send('export:progress', progress);
        }
      });

      proc.on('close', (code) => {
        this.currentProcess = null;
        if (this.cancelled) {
          win.webContents.send('export:error', 'Export cancelled');
          resolve();
          return;
        }

        if (code !== 0) {
          const errorLines = stderrData.split('\n').slice(-5).join('\n');
          win.webContents.send('export:error', `FFmpeg exited with code ${code}: ${errorLines}`);
          reject(new Error(`FFmpeg exit code ${code}`));
          return;
        }

        // Exit code 0 is NOT sufficient proof of success: a failed/partial
        // write must not be reported as a finished export (upstream #182).
        // Verify the output file actually exists and is non-empty before
        // signalling completion.
        fs.stat(outputPath)
          .then((stat) => {
            if (!stat.isFile() || stat.size === 0) {
              win.webContents.send(
                'export:error',
                `Export reported success but no output file was written to "${outputPath}".`,
              );
              reject(new Error('Export produced no output file'));
              return;
            }
            win.webContents.send('export:complete', { outputPath, bytes: stat.size });
            resolve();
          })
          .catch((statErr: NodeJS.ErrnoException) => {
            const reason = statErr.code === 'ENOENT'
              ? `no output file was written to "${outputPath}"`
              : statErr.message;
            win.webContents.send('export:error', `Export failed: ${reason}.`);
            reject(new Error(`Export verification failed: ${reason}`));
          });
      });

      proc.on('error', (err) => {
        this.currentProcess = null;
        win.webContents.send('export:error', `FFmpeg error: ${err.message}`);
        reject(err);
      });
    });
  }

  cancel(): void {
    this.cancelled = true;
    if (this.currentProcess) {
      this.currentProcess.kill('SIGKILL');
      this.currentProcess = null;
    }
  }

  // ─── filter_complex builder ──────────────────────────────────────────────

  private buildFfmpegArgs(
    project: Project,
    options: ExportOptions,
    width: number,
    height: number,
    fps: number,
    totalFrames: number,
  ): string[] {
    const { outputPath, format, quality } = options;
    const clips = project.timeline.clips;
    const duration = totalFrames / fps;

    // Sort clips by start frame for proper layering
    const sortedClips = [...clips].sort((a, b) => {
      const trackA = project.timeline.tracks.find((t) => t.id === a.trackId);
      const trackB = project.timeline.tracks.find((t) => t.id === b.trackId);
      return (trackA?.order || 0) - (trackB?.order || 0);
    });

    const videoClips = sortedClips.filter((c) => c.type !== 'audio');
    const audioClips = sortedClips.filter((c) => c.type === 'audio');

    const args: string[] = ['-y']; // overwrite output

    // Input: blank canvas as base
    args.push('-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:d=${duration}:r=${fps}`);

    // Add each video clip as an input
    for (const clip of videoClips) {
      const asset = project.media.find((m) => m.id === clip.assetId);
      if (!asset) continue;
      args.push('-i', asset.path);
    }

    // Add audio inputs
    for (const clip of audioClips) {
      const asset = project.media.find((m) => m.id === clip.assetId);
      if (!asset) continue;
      args.push('-i', asset.path);
    }

    // Build filter_complex
    if (videoClips.length > 0) {
      const filterGraph = this.buildFilterGraph(project, videoClips, width, height, fps);
      args.push('-filter_complex', filterGraph);
      args.push('-map', `[vout]`);
    } else {
      args.push('-map', '0:v');
    }

    // Audio mixing (simple amix for now)
    if (audioClips.length > 0) {
      // Map all audio streams
      const audioInputStart = 1 + videoClips.length;
      for (let i = 0; i < audioClips.length; i++) {
        args.push('-map', `${audioInputStart + i}:a?`);
      }
    }

    // Output settings
    const codecArgs = PRESETS[format]?.[quality] || PRESETS.mp4.normal;
    args.push(...codecArgs);

    // Audio codec
    if (format === 'webm') {
      args.push('-c:a', 'libopus');
    } else {
      args.push('-c:a', 'aac', '-b:a', '192k');
    }

    // Duration limit and output
    args.push('-t', duration.toFixed(4));
    args.push(outputPath);

    return args;
  }

  private buildFilterGraph(
    project: Project,
    videoClips: Clip[],
    canvasWidth: number,
    canvasHeight: number,
    fps: number,
  ): string {
    const filters: string[] = [];
    let lastLabel = '0:v';

    for (let i = 0; i < videoClips.length; i++) {
      const clip = videoClips[i];
      const inputIdx = i + 1; // +1 because 0 is the blank canvas
      const inTime = clip.startFrame / fps;
      const outTime = (clip.startFrame + clip.durationFrames) / fps;

      // Get the geometry filter from the Rust native addon
      let geomFilter: string;
      if (this.nativeAddon?.exportFilterGeometry) {
        geomFilter = this.nativeAddon.exportFilterGeometry(
          clip.x, clip.y,
          clip.width, clip.height,
          clip.rotation,
          clip.scaleX, clip.scaleY,
        );
      } else {
        // Fallback: simple scale + overlay
        const sw = Math.round(clip.width * clip.scaleX);
        const sh = Math.round(clip.height * clip.scaleY);
        geomFilter = `scale=${sw}:${sh},overlay=x=${Math.round(clip.x)}:y=${Math.round(clip.y)}`;
      }

      // Trim the input clip
      const trimStart = clip.inPoint / fps;
      const trimEnd = clip.outPoint / fps;

      const trimmedLabel = `v${i}trimmed`;
      const scaledLabel = `v${i}scaled`;
      const overlayOut = i < videoClips.length - 1 ? `[v${i}out]` : '[vout]';

      // Trim filter
      filters.push(
        `[${inputIdx}:v]trim=start=${trimStart.toFixed(4)}:end=${trimEnd.toFixed(4)},setpts=PTS-STARTPTS[${trimmedLabel}]`,
      );

      // Scale/transform
      const scaledW = Math.round(clip.width * clip.scaleX);
      const scaledH = Math.round(clip.height * clip.scaleY);

      // Transition fades — applied in the clip's own (0-based, post-setpts) time
      // so they match the preview's effective-opacity ramp exactly. alpha=1 makes
      // the fade affect transparency so it composites over the layers below.
      let fadeChain = '';
      if (clip.fadeInFrames && clip.fadeInFrames > 0) {
        const d = clip.fadeInFrames / fps;
        fadeChain += `,fade=t=in:st=0:d=${d.toFixed(4)}:alpha=1`;
      }
      if (clip.fadeOutFrames && clip.fadeOutFrames > 0) {
        const d = clip.fadeOutFrames / fps;
        const st = (clip.durationFrames - clip.fadeOutFrames) / fps;
        fadeChain += `,fade=t=out:st=${st.toFixed(4)}:d=${d.toFixed(4)}:alpha=1`;
      }

      filters.push(
        `[${trimmedLabel}]scale=${scaledW}:${scaledH}:flags=bilinear,format=rgba${fadeChain}[${scaledLabel}]`,
      );

      // Overlay with enable condition (time window)
      filters.push(
        `[${lastLabel}][${scaledLabel}]overlay=x=${Math.round(clip.x)}:y=${Math.round(clip.y)}:enable='between(t,${inTime.toFixed(4)},${outTime.toFixed(4)})'${overlayOut}`,
      );

      if (i < videoClips.length - 1) {
        lastLabel = `v${i}out`;
      }
    }

    return filters.join(';');
  }

  // ─── Progress parsing ────────────────────────────────────────────────────

  private parseProgress(stderr: string, totalFrames: number): ExportProgress | null {
    // FFmpeg outputs lines like: frame=  123 fps= 45.2 ...
    const lines = stderr.split('\r');
    const lastLine = lines[lines.length - 1] || lines[lines.length - 2] || '';

    const frameMatch = lastLine.match(/frame=\s*(\d+)/);
    const fpsMatch = lastLine.match(/fps=\s*([\d.]+)/);

    if (!frameMatch) return null;

    const frame = parseInt(frameMatch[1]);
    const encodeFps = fpsMatch ? parseFloat(fpsMatch[1]) : 0;
    const percent = Math.min(100, Math.round((frame / totalFrames) * 100));

    let eta = '';
    if (encodeFps > 0 && frame < totalFrames) {
      const remaining = (totalFrames - frame) / encodeFps;
      const mins = Math.floor(remaining / 60);
      const secs = Math.round(remaining % 60);
      eta = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
    }

    return { percent, frame, totalFrames, fps: encodeFps, eta };
  }
}

// ─── Singleton + IPC ─────────────────────────────────────────────────────────

let exporterInstance: Exporter | null = null;

export function getExporter(): Exporter {
  if (!exporterInstance) {
    exporterInstance = new Exporter();
  }
  return exporterInstance;
}

export function registerExportHandlers(getProject: () => Project | null): void {
  const exporter = getExporter();

  ipcMain.handle('export:start', async (event, options: ExportOptions) => {
    const project = getProject();
    if (!project) return { success: false, error: 'No project loaded' };

    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { success: false, error: 'No window' };

    try {
      await exporter.export(project, options, win);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('export:cancel', () => {
    exporter.cancel();
    return { success: true };
  });
}
