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

import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import { ipcMain, BrowserWindow, shell } from 'electron';
import fs from 'fs/promises';
import fsSync from 'fs';
import type { Project } from '../../shared/types/project';
import { selectExportClips } from '../../shared/media/export-eligibility';
import { offlineExportBlockers, formatOfflineNames } from '../../shared/media/offline';
import { buildFfmpegArgs as buildExportFfmpegArgs } from './export-args';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ExportOptions {
  outputPath: string;
  format: 'mp4' | 'mov' | 'webm' | 'audio';
  quality: 'draft' | 'normal' | 'high';
  width?: number;
  height?: number;
  fps?: number;
  /** Export only this timeline span (In/Out marks), frames inclusive-exclusive. */
  range?: { start: number; end: number };
}

export interface ExportProgress {
  percent: number;
  frame: number;
  totalFrames: number;
  fps: number; // encoding fps
  eta: string; // estimated time remaining
}

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
    const { outputPath } = options;
    const width = options.width || project.settings.width;
    const height = options.height || project.settings.height;
    const fps = options.fps || project.settings.fps;

    // Calculate total frames over exactly the clips the export will consume,
    // so the reported duration and the rendered output cannot disagree
    // (muted-audio exclusion is shared with the argument builder, #544).
    const clips = selectExportClips(project);
    const totalFrames = options.range
      ? options.range.end - options.range.start
      : clips.length > 0
        ? Math.max(...clips.map((c) => c.startFrame + c.durationFrames))
        : 0;

    if (totalFrames === 0) {
      win.webContents.send('export:error', 'No clips on timeline');
      return;
    }
    if (options.format === 'audio' && !clips.some((c) => c.type === 'audio')) {
      const message = 'No audio to export — add an audio clip or pick a video format.';
      win.webContents.send('export:error', message);
      throw new Error(message);
    }

    // Loud pre-flight: a missing source file would otherwise render as a
    // black hole or fail mid-encode. Refuse with the filenames named so the
    // user can relink from the media panel (upstream R0 offline state).
    const blockers = offlineExportBlockers(project, (p) => fsSync.existsSync(p));
    if (blockers.length > 0) {
      const message = `Media offline: ${formatOfflineNames(blockers)}. Relink or remove ${blockers.length === 1 ? 'it' : 'them'} before exporting.`;
      win.webContents.send('export:error', message);
      // The IPC wrapper turns this into { success:false } for the caller.
      throw new Error(message);
    }

    // Build the FFmpeg command
    let args: string[];
    try {
      args = this.buildFfmpegArgs(project, options, width, height, fps, totalFrames);
    } catch (err) {
      // Argument-building refusals (e.g. audio-only with no eligible audio)
      // are user-facing; surface them through the same channel as progress.
      const message = err instanceof Error ? err.message : String(err);
      win.webContents.send('export:error', message);
      throw err;
    }
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
    // Graph construction lives in ./export-args (pure, unit-tested); this
    // only supplies the native geometry callback (#546).
    return buildExportFfmpegArgs(
      project,
      { outputPath: options.outputPath, format: options.format, quality: options.quality },
      width,
      height,
      fps,
      totalFrames,
      this.nativeAddon?.exportFilterGeometry ?? null,
    );
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

  ipcMain.handle('export:reveal', (_event, outputPath: string) => {
    if (typeof outputPath === 'string' && outputPath.length > 0) {
      shell.showItemInFolder(outputPath);
    }
    return { success: true };
  });
}
