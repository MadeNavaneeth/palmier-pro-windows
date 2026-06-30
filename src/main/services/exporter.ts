/**
 * FFmpeg Export Pipeline — constructs a filter_complex from the timeline state
 * and executes the export as a background ffmpeg process with progress reporting.
 *
 * The geometry calculations use the same affine math as the Rust compositor's
 * `to_ffmpeg_filter()`, ensuring pixel-exact consistency between preview and export.
 *
 * Architecture:
 * 1. Analyze timeline → collect all source clips, sorted by track order
 * 2. Build input list (-i for each unique source file)
 * 3. Build filter_complex graph (scale, rotate, overlay per layer)
 * 4. Set output encoding params (codec, bitrate, format)
 * 5. Spawn ffmpeg, parse stderr for progress, emit percentage via IPC
 */

import { execFile, ChildProcess } from 'child_process';
import { ipcMain, BrowserWindow } from 'electron';
import path from 'path';
import type { Project, Clip, Track, Frame, ProjectSettings } from '../../shared/types/project';
import { frameToSeconds } from '../../shared/utils/time';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ExportOptions {
  outputPath: string;
  format: 'mp4' | 'mov' | 'webm';
  quality: 'draft' | 'normal' | 'high';
  width?: number;
  height?: number;
}

export interface ExportProgress {
  percent: number;
  currentFrame: number;
  totalFrames: number;
  fps: number; // encoding fps
  elapsed: number; // seconds
  eta: number; // estimated seconds remaining
}

interface InputMapping {
  inputIndex: number;
  filePath: string;
  assetId: string;
}

// ─── Quality presets ─────────────────────────────────────────────────────────

const QUALITY_PRESETS = {
  draft: { crf: 28, preset: 'ultrafast', audioBitrate: '128k' },
  normal: { crf: 20, preset: 'medium', audioBitrate: '192k' },
  high: { crf: 16, preset: 'slow', audioBitrate: '320k' },
} as const;

const FORMAT_CODECS = {
  mp4: { video: 'libx264', audio: 'aac', ext: 'mp4' },
  mov: { video: 'libx264', audio: 'aac', ext: 'mov' },
  webm: { video: 'libvpx-vp9', audio: 'libopus', ext: 'webm' },
} as const;

// ─── Exporter ────────────────────────────────────────────────────────────────

export class Exporter {
  private activeProcess: ChildProcess | null = null;
  private aborted = false;

  constructor() {
    this.registerIpcHandlers();
  }

  private registerIpcHandlers(): void {
    ipcMain.handle('export:start', async (_event, projectJson: string, optionsJson: string) => {
      try {
        const project: Project = JSON.parse(projectJson);
        const options: ExportOptions = JSON.parse(optionsJson);
        await this.startExport(project, options);
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('export:cancel', () => {
      this.cancel();
      return { success: true };
    });
  }

  async startExport(project: Project, options: ExportOptions): Promise<void> {
    this.aborted = false;

    const args = this.buildFfmpegArgs(project, options);
    const totalFrames = this.getProjectDuration(project);
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      const proc = execFile('ffmpeg', args, { maxBuffer: 50 * 1024 * 1024 });
      this.activeProcess = proc;

      // FFmpeg writes progress to stderr
      proc.stderr?.on('data', (data: Buffer) => {
        const line = data.toString();
        const progress = this.parseProgress(line, totalFrames, startTime);
        if (progress) {
          this.emitProgress(progress);
        }
      });

      proc.on('close', (code) => {
        this.activeProcess = null;
        if (this.aborted) {
          reject(new Error('Export cancelled by user.'));
        } else if (code === 0) {
          this.emitProgress({
            percent: 100,
            currentFrame: totalFrames,
            totalFrames,
            fps: 0,
            elapsed: (Date.now() - startTime) / 1000,
            eta: 0,
          });
          resolve();
        } else {
          reject(new Error(`FFmpeg exited with code ${code}`));
        }
      });

      proc.on('error', (err) => {
        this.activeProcess = null;
        reject(err);
      });
    });
  }

  cancel(): void {
    this.aborted = true;
    if (this.activeProcess) {
      this.activeProcess.kill('SIGTERM');
      this.activeProcess = null;
    }
  }

  isExporting(): boolean {
    return this.activeProcess !== null;
  }

  // ─── FFmpeg argument construction ──────────────────────────────────────────

  buildFfmpegArgs(project: Project, options: ExportOptions): string[] {
    const settings = project.settings;
    const clips = this.getSortedClips(project);
    const outputWidth = options.width || settings.width;
    const outputHeight = options.height || settings.height;

    if (clips.length === 0) {
      throw new Error('No clips on timeline to export.');
    }

    // Deduplicate source files → input indices
    const inputs = this.buildInputMapping(project, clips);
    const formatCodec = FORMAT_CODECS[options.format];
    const quality = QUALITY_PRESETS[options.quality];
    const totalDuration = frameToSeconds(this.getProjectDuration(project), settings.fps);

    const args: string[] = ['-y']; // overwrite output

    // Inputs
    for (const input of inputs) {
      args.push('-i', input.filePath);
    }

    // Filter complex
    const filterComplex = this.buildFilterComplex(clips, inputs, settings, outputWidth, outputHeight);
    if (filterComplex) {
      args.push('-filter_complex', filterComplex);
      args.push('-map', '[vout]');

      // Check if we have audio clips
      const hasAudio = clips.some((c) => c.type === 'audio' || project.media.find((m) => m.id === c.assetId)?.audioCodec);
      if (hasAudio) {
        args.push('-map', '[aout]');
      }
    }

    // Video encoding
    args.push('-c:v', formatCodec.video);
    if (formatCodec.video === 'libx264') {
      args.push('-crf', String(quality.crf));
      args.push('-preset', quality.preset);
      args.push('-pix_fmt', 'yuv420p');
    } else if (formatCodec.video === 'libvpx-vp9') {
      args.push('-crf', String(quality.crf));
      args.push('-b:v', '0');
    }

    // Audio encoding
    args.push('-c:a', formatCodec.audio);
    args.push('-b:a', quality.audioBitrate);

    // Duration limit
    args.push('-t', String(totalDuration));

    // Frame rate
    args.push('-r', String(settings.fps));

    // Output dimensions
    args.push('-s', `${outputWidth}x${outputHeight}`);

    // Output file
    args.push(options.outputPath);

    return args;
  }

  private buildInputMapping(project: Project, clips: Clip[]): InputMapping[] {
    const seen = new Map<string, number>();
    const inputs: InputMapping[] = [];

    for (const clip of clips) {
      const asset = project.media.find((m) => m.id === clip.assetId);
      if (!asset) continue;

      if (!seen.has(asset.path)) {
        seen.set(asset.path, inputs.length);
        inputs.push({
          inputIndex: inputs.length,
          filePath: asset.path,
          assetId: asset.id,
        });
      }
    }

    return inputs;
  }

  /**
   * Build the filter_complex graph. Each video clip becomes:
   *   [inputN] trim/setpts → scale → rotate → [layerN]
   *   [prev][layerN] overlay=x:y → [nextBase]
   *
   * Audio clips are amerged together.
   */
  private buildFilterComplex(
    clips: Clip[],
    inputs: InputMapping[],
    settings: ProjectSettings,
    outputWidth: number,
    outputHeight: number,
  ): string {
    const videoClips = clips.filter((c) => c.type !== 'audio');
    const audioClips = clips.filter((c) => c.type === 'audio');
    const filters: string[] = [];

    // Create a black background canvas
    filters.push(
      `color=c=${settings.backgroundColor}:s=${outputWidth}x${outputHeight}:d=${frameToSeconds(this.getProjectDurationFromClips(clips), settings.fps)}:r=${settings.fps}[base]`,
    );

    let currentBase = 'base';
    let layerIdx = 0;

    for (const clip of videoClips) {
      const inputIdx = this.getInputIndex(clip, inputs);
      if (inputIdx === -1) continue;

      const inSec = frameToSeconds(clip.inPoint, settings.fps);
      const durSec = frameToSeconds(clip.durationFrames, settings.fps);
      const startSec = frameToSeconds(clip.startFrame, settings.fps);

      const layerLabel = `layer${layerIdx}`;
      const outputLabel = `out${layerIdx}`;

      // Trim + time-shift the source
      let layerFilter = `[${inputIdx}:v]trim=start=${inSec}:duration=${durSec},setpts=PTS-STARTPTS`;

      // Scale
      const scaledW = Math.round(clip.width * clip.scaleX);
      const scaledH = Math.round(clip.height * clip.scaleY);
      if (scaledW !== outputWidth || scaledH !== outputHeight || clip.scaleX !== 1 || clip.scaleY !== 1) {
        layerFilter += `,scale=${scaledW}:${scaledH}`;
      }

      // Rotation
      if (Math.abs(clip.rotation) > 0.01) {
        const rad = (clip.rotation * Math.PI) / 180;
        layerFilter += `,rotate=${rad}:ow=rotw(${rad}):oh=roth(${rad}):fillcolor=none`;
      }

      // Opacity (via format for alpha support)
      if (clip.opacity < 1) {
        layerFilter += `,format=rgba,colorchannelmixer=aa=${clip.opacity}`;
      }

      layerFilter += `[${layerLabel}]`;
      filters.push(layerFilter);

      // Overlay this layer onto the running composite
      const overlayX = Math.round(clip.x);
      const overlayY = Math.round(clip.y);
      const enableExpr = `between(t,${startSec},${startSec + durSec})`;
      filters.push(
        `[${currentBase}][${layerLabel}]overlay=x=${overlayX}:y=${overlayY}:enable='${enableExpr}'[${outputLabel}]`,
      );

      currentBase = outputLabel;
      layerIdx++;
    }

    // Final video output
    filters.push(`[${currentBase}]copy[vout]`);

    // Audio mixing
    if (audioClips.length > 0) {
      const audioStreams: string[] = [];
      for (const clip of audioClips) {
        const inputIdx = this.getInputIndex(clip, inputs);
        if (inputIdx === -1) continue;

        const inSec = frameToSeconds(clip.inPoint, settings.fps);
        const durSec = frameToSeconds(clip.durationFrames, settings.fps);
        const delaySec = frameToSeconds(clip.startFrame, settings.fps);
        const streamLabel = `audio${audioStreams.length}`;

        let audioFilter = `[${inputIdx}:a]atrim=start=${inSec}:duration=${durSec},asetpts=PTS-STARTPTS`;

        // Volume
        if (clip.volume !== 1) {
          audioFilter += `,volume=${clip.volume}`;
        }

        // Delay (shift audio to timeline position)
        if (delaySec > 0) {
          const delayMs = Math.round(delaySec * 1000);
          audioFilter += `,adelay=${delayMs}|${delayMs}`;
        }

        audioFilter += `[${streamLabel}]`;
        filters.push(audioFilter);
        audioStreams.push(`[${streamLabel}]`);
      }

      if (audioStreams.length === 1) {
        filters.push(`${audioStreams[0]}acopy[aout]`);
      } else if (audioStreams.length > 1) {
        filters.push(`${audioStreams.join('')}amix=inputs=${audioStreams.length}:duration=longest[aout]`);
      }
    } else {
      // Generate silent audio
      const durSec = frameToSeconds(this.getProjectDurationFromClips(clips), settings.fps);
      filters.push(`anullsrc=r=48000:cl=stereo,atrim=0:${durSec}[aout]`);
    }

    return filters.join(';');
  }

  private getInputIndex(clip: Clip, inputs: InputMapping[]): number {
    const mapping = inputs.find((i) => i.assetId === clip.assetId);
    return mapping ? mapping.inputIndex : -1;
  }

  // ─── Progress parsing ──────────────────────────────────────────────────────

  private parseProgress(line: string, totalFrames: number, startTime: number): ExportProgress | null {
    // FFmpeg progress line: "frame=  123 fps= 30 q=28.0 size=    256kB time=00:00:04.10 ..."
    const frameMatch = line.match(/frame=\s*(\d+)/);
    const fpsMatch = line.match(/fps=\s*([\d.]+)/);

    if (!frameMatch) return null;

    const currentFrame = parseInt(frameMatch[1]);
    const encodingFps = fpsMatch ? parseFloat(fpsMatch[1]) : 0;
    const elapsed = (Date.now() - startTime) / 1000;
    const percent = totalFrames > 0 ? Math.min(99, (currentFrame / totalFrames) * 100) : 0;

    // ETA calculation
    let eta = 0;
    if (encodingFps > 0 && currentFrame > 0) {
      const remainingFrames = totalFrames - currentFrame;
      eta = remainingFrames / encodingFps;
    }

    return { percent, currentFrame, totalFrames, fps: encodingFps, elapsed, eta };
  }

  private emitProgress(progress: ExportProgress): void {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      win.webContents.send('export:progress', progress);
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private getSortedClips(project: Project): Clip[] {
    const tracks = project.timeline.tracks;
    return [...project.timeline.clips].sort((a, b) => {
      const trackA = tracks.find((t) => t.id === a.trackId);
      const trackB = tracks.find((t) => t.id === b.trackId);
      return (trackA?.order ?? 0) - (trackB?.order ?? 0);
    });
  }

  private getProjectDuration(project: Project): Frame {
    const clips = project.timeline.clips;
    if (clips.length === 0) return 0;
    return Math.max(...clips.map((c) => c.startFrame + c.durationFrames));
  }

  private getProjectDurationFromClips(clips: Clip[]): Frame {
    if (clips.length === 0) return 0;
    return Math.max(...clips.map((c) => c.startFrame + c.durationFrames));
  }
}
