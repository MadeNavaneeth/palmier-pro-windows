/**
 * FFmpeg Exporter — converts the timeline state into a filter_complex graph
 * and runs FFmpeg to produce the final video file.
 *
 * The FFmpeg graph is built by the pure export-args module; this class owns
 * process lifetime, cancellation, and delivery events.
 *
 * Supports: MP4 (H.264), MOV (ProRes proxy), WebM (VP9).
 * Reports progress back to the renderer via IPC events.
 */

import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import { ipcMain, BrowserWindow, shell, dialog, app } from 'electron';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
import type { Clip, Project } from '../../shared/types/project';
import { resolveRenderTimeline } from '../../shared/editor/compound';
import { selectExportClips } from '../../shared/media/export-eligibility';
import { offlineExportBlockers, formatOfflineNames } from '../../shared/media/offline';
import { buildVtt } from '../../shared/editor/vtt';
import { recordExport, loadExportHistory } from './export-history';
import { buildFfmpegArgs as buildExportFfmpegArgs } from './export-args';
import type { HdrProfile } from './export-args';
import { validateLutFile } from './lut-loader';
import type { SessionSender } from '../sessions';

/**
 * LUT preflight for one export: clips whose .cube file is missing or
 * unreadable render without the LUT stage (the path is validated on use, so
 * a file that moved after it was chosen degrades instead of failing).
 * Appends one visible warning per stripped clip; returns the project itself
 * when nothing was stripped. Main and nested timelines are stripped alike —
 * the argument builder consumes the resolved (flattened) timeline.
 */
export function stripMissingLuts(project: Project, warnings: string[]): Project {
  const stripClips = (clips: Clip[]): { clips: Clip[]; stripped: boolean } => {
    let stripped = false;
    const next = clips.map((clip) => {
      if (!clip.lut) return clip;
      if (validateLutFile(clip.lut.path).ok) return clip;
      stripped = true;
      const name = clip.lut.path.split(/[\\/]/).pop() ?? clip.lut.path;
      warnings.push(
        `Clip "${clip.label ?? clip.id}" renders without its LUT (${name} is missing or invalid).`,
      );
      const rest: Clip = { ...clip };
      delete rest.lut;
      return rest;
    });
    return { clips: next, stripped };
  };
  const main = stripClips(project.timeline.clips);
  let stripped = main.stripped;
  let timelines = project.timelines;
  if (project.timelines) {
    let timelinesChanged = false;
    const next: NonNullable<Project['timelines']> = {};
    for (const [id, nested] of Object.entries(project.timelines)) {
      const result = stripClips(nested.clips);
      next[id] = result.stripped ? { ...nested, clips: result.clips } : nested;
      if (result.stripped) {
        timelinesChanged = true;
        stripped = true;
      }
    }
    if (timelinesChanged) timelines = next;
  }
  if (!stripped) return project;
  const next: Project = {
    ...project,
    timeline: { ...project.timeline, clips: main.clips },
  };
  if (timelines !== project.timelines) next.timelines = timelines;
  return next;
}

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
  /** Write a WebVTT sidecar next to the output for title/caption clips. */
  exportCaptions?: boolean;
  /** Hardware encoder preference (mp4 only; others fall back to software). */
  hw?: 'x264' | 'nvenc' | 'qsv' | 'amf';
  /**
   * HDR delivery profile (upstream #59): absent/'sdr' keeps the Rec.709
   * 8-bit path; 'hlg'/'pq' encode HEVC Main10 with BT.2020 conversion/tags
   * (validated strictly by the argument builder — an invalid value refuses
   * the export rather than downgrading to SDR). Preview stays SDR: the
   * timeline preview is the 8-bit Rec.709 working space and is not
   * re-tinted for the HDR selection.
   */
  hdr?: HdrProfile;
  /**
   * Renderer-baked layers (#525/#529, plus shape boxes): full-canvas RGBA
   * PNGs for advanced titles and box-sized RGBA PNGs for shapes, keyed by
   * clip id, composited instead of drawtext for those clips.
   */
  bakedTitles?: ReadonlyArray<{ clipId: string; path: string }>;
  /** Directory holding `bakedTitles`; removed when the export settles. */
  bakedTempDir?: string;
}

export interface ExportProgress {
  percent: number;
  frame: number;
  totalFrames: number;
  fps: number; // encoding fps
  eta: string; // estimated time remaining
}

/**
 * Where export events go.
 *
 * The IPC path passes `win.webContents`; the Agent/MCP path passes a sink
 * that captures the receipt, so `Exporter.export` itself never needs an
 * Electron window and can run from a tool call.
 */
export interface ExportEventSink {
  send(channel: string, payload?: unknown): void;
}

// ─── Exporter ────────────────────────────────────────────────────────────────

/**
 * One in-flight FFmpeg run. Jobs are tracked per owner — a session id for
 * window exports, `'default'` for agent/MCP runs — so each job carries its
 * own process and cancel flag and `cancel(owner)` can never flip or kill
 * another session's export (#137 Slice 3).
 */
interface ExportJob {
  process: ChildProcess | null;
  cancelled: boolean;
}

export class Exporter {
  /** Live jobs by owner; entries appear at spawn and go when the run settles. */
  private readonly jobs = new Map<string, ExportJob>();

  async export(
    project: Project,
    options: ExportOptions,
    sink: ExportEventSink,
    owner = 'default',
  ): Promise<void> {
    const { outputPath } = options;
    const width = options.width || project.settings.width;
    const height = options.height || project.settings.height;
    const fps = options.fps || project.settings.fps;

    // Calculate total frames over exactly the clips the export will consume,
    // so the reported duration and the rendered output cannot disagree
    // (muted-audio exclusion is shared with the argument builder, #544).
    // Compound clips expand first: nested audio counts toward the audio-only
    // check, and the extent matches the flattened timeline the graph builder
    // consumes.
    const view: Project = { ...project, timeline: resolveRenderTimeline(project) };
    const clips = selectExportClips(view);
    const totalFrames = options.range
      ? options.range.end - options.range.start
      : clips.length > 0
        ? Math.max(...clips.map((c) => c.startFrame + c.durationFrames))
        : 0;

    if (totalFrames === 0) {
      sink.send('export:error', 'No clips on timeline');
      return;
    }
    if (options.format === 'audio' && !clips.some((c) => c.type === 'audio')) {
      const message = 'No audio to export — add an audio clip or pick a video format.';
      sink.send('export:error', message);
      throw new Error(message);
    }

    // Loud pre-flight: a missing source file would otherwise render as a
    // black hole or fail mid-encode. Refuse with the filenames named so the
    // user can relink from the media panel (upstream R0 offline state).
    // Resolved like the extent above so media used only inside a nest blocks
    // too, while the compound's own synthetic asset id never does.
    const blockers = offlineExportBlockers(view, (p) => fsSync.existsSync(p));
    if (blockers.length > 0) {
      const message = `Media offline: ${formatOfflineNames(blockers)}. Relink or remove ${blockers.length === 1 ? 'it' : 'them'} before exporting.`;
      sink.send('export:error', message);
      // The IPC wrapper turns this into { success:false } for the caller.
      throw new Error(message);
    }

    // LUT preflight (#157 LUTs): a clip whose .cube file went missing or
    // unreadable after it was chosen degrades to ungraded for that stage
    // rather than failing the whole export — the stripped clip ids ride an
    // `export:warning` event so the skip is visible, never silent.
    const lutWarnings: string[] = [];
    const exportProject: Project = stripMissingLuts(project, lutWarnings);
    if (lutWarnings.length > 0) {
      sink.send('export:warning', lutWarnings.join(' '));
    }

    // Build the FFmpeg command
    let args: string[];
    // Layers the graph could not render faithfully (a shape with no baked
    // box, an advanced title degraded to drawtext). They ride the same
    // `export:warning` channel as the LUT preflight, so every caller —
    // the delivery panel's event listener and the agent's receipt alike —
    // sees the shortfall instead of a plausible-looking wrong render.
    const layerWarnings: string[] = [];
    try {
      args = this.buildFfmpegArgs(exportProject, options, width, height, fps, totalFrames, layerWarnings);
    } catch (err) {
      // Argument-building refusals (e.g. audio-only with no eligible audio)
      // are user-facing; surface them through the same channel as progress.
      const message = err instanceof Error ? err.message : String(err);
      sink.send('export:error', message);
      throw err;
    }
    for (const warning of layerWarnings) {
      sink.send('export:warning', warning);
    }
    sink.send('export:progress', {
      percent: 0,
      frame: 0,
      totalFrames,
      fps: 0,
      eta: 'Calculating...',
    } satisfies ExportProgress);

    // Run FFmpeg; the baked-title temp directory dies with the run whether it
    // resolves, rejects, or is cancelled. The job is registered for this owner
    // so a cancel from the owning session reaches exactly this process.
    const job: ExportJob = { process: null, cancelled: false };
    this.jobs.set(owner, job);
    try {
      const run = new Promise<void>((resolve, reject) => {
        const proc = spawn('ffmpeg', args, {
          stdio: ['ignore', 'ignore', 'pipe'], // stderr for progress
          windowsHide: true,
        });
        job.process = proc;

        let stderrData = '';

        proc.stderr!.on('data', (chunk: Buffer) => {
          stderrData += chunk.toString();

          // Parse progress from FFmpeg stderr
          const progress = this.parseProgress(stderrData, totalFrames);
          if (progress) {
            sink.send('export:progress', progress);
          }
        });

        proc.on('close', (code) => {
          job.process = null;
          if (job.cancelled) {
            sink.send('export:error', 'Export cancelled');
            resolve();
            return;
          }

          if (code !== 0) {
            const errorLines = stderrData.split('\n').slice(-5).join('\n');
            sink.send('export:error', `FFmpeg exited with code ${code}: ${errorLines}`);
            reject(new Error(`FFmpeg exit code ${code}`));
            return;
          }

          // Exit code 0 is NOT sufficient proof of success: a failed/partial
          // write must not be reported as a finished export (upstream #182).
          // Verify the output file actually exists and is non-empty before
          // signalling completion.
          fs.stat(outputPath)
            .then(async (stat) => {
              if (!stat.isFile() || stat.size === 0) {
                sink.send(
                  'export:error',
                  `Export reported success but no output file was written to "${outputPath}".`,
                );
                reject(new Error('Export produced no output file'));
                return;
              }
              // WebVTT sidecar (R3): title clips become a caption file next to
              // the video. A sidecar write failure must not fail the finished
              // video, so it is logged and skipped instead. Cues come from the
              // SAME resolved view the graph is built from, so a title inside a
              // compound is both drawn and captioned at one timing — the
              // unresolved timeline would drop the nested cues and leave a
              // burned-in title with an empty sidecar beside it.
              if (options.exportCaptions) {
                try {
                  const cues = view.timeline.clips
                    .filter((clip) => clip.type === 'title' && clip.text)
                    .map((clip) => ({
                      startSec: clip.startFrame / fps,
                      endSec: (clip.startFrame + clip.durationFrames) / fps,
                      text: clip.text ?? '',
                    }));
                  const vttPath = outputPath.replace(/\.[^.]+$/, '') + '.vtt';
                  await fs.writeFile(vttPath, buildVtt(cues), 'utf8');
                } catch (err) {
                  console.warn('[exporter] VTT sidecar write failed:', err);
                }
              }
              recordExport({
                outputPath,
                format: options.format,
                quality: options.quality,
                projectName: project.name,
                completedAt: new Date().toISOString(),
                bytes: stat.size,
                options: {
                  format: options.format,
                  quality: options.quality,
                  width: options.width ?? project.settings.width,
                  height: options.height ?? project.settings.height,
                  fps: options.fps ?? project.settings.fps,
                  ...(options.range ? { range: options.range } : {}),
                  ...(options.exportCaptions !== undefined ? { exportCaptions: options.exportCaptions } : {}),
                  ...(options.hdr !== undefined ? { hdr: options.hdr } : {}),
                },
              });
              sink.send('export:complete', { outputPath, bytes: stat.size });
              resolve();
            })
            .catch((statErr: NodeJS.ErrnoException) => {
              const reason = statErr.code === 'ENOENT'
                ? `no output file was written to "${outputPath}"`
                : statErr.message;
              sink.send('export:error', `Export failed: ${reason}.`);
              reject(new Error(`Export verification failed: ${reason}`));
            });
        });

        proc.on('error', (err) => {
          job.process = null;
          sink.send('export:error', `FFmpeg error: ${err.message}`);
          reject(err);
        });
      });
      void run.finally(() => {
        if (options.bakedTempDir) {
          void fs.rm(options.bakedTempDir, { recursive: true, force: true }).catch(() => {});
        }
      });
      return await run;
    } finally {
      // A later export from the same owner may already have replaced this
      // job; only the owner's current job removes itself.
      if (this.jobs.get(owner) === job) this.jobs.delete(owner);
    }
  }

  /** Cancel only this owner's in-flight export — never another session's. */
  cancel(owner: string): void {
    const job = this.jobs.get(owner);
    if (!job) return;
    job.cancelled = true;
    if (job.process) {
      job.process.kill('SIGKILL');
      job.process = null;
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
    /** Layers the graph could not render; filled in, never read here. */
    warnings?: string[],
  ): string[] {
    // Graph construction lives in ./export-args (pure, unit-tested). The
    // native export_filter_geometry API predates this graph, omits anchor and
    // alpha/pipeline ordering, and has no caller; keep export geometry here.
    return buildExportFfmpegArgs(
      project,
      {
        outputPath: options.outputPath,
        format: options.format,
        quality: options.quality,
        // Both were silently dropped before: range exports rendered the head
        // of the full timeline, and the encoder selector never reached FFmpeg.
        ...(options.range ? { range: options.range } : {}),
        ...(options.hw ? { hw: options.hw } : {}),
        ...(options.hdr !== undefined ? { hdr: options.hdr } : {}),
        ...(options.bakedTitles ? { bakedTitles: options.bakedTitles } : {}),
      },
      width,
      height,
      fps,
      totalFrames,
      warnings,
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

/** The session id + project an export IPC sender resolves to (#137). */
export interface ExportRequestContext {
  sessionId: string;
  project: Project;
}

/**
 * Register export IPC.
 *
 * `resolve` maps the requesting sender to its session id and session
 * project (#137 Slice 3): `export:start` registers its FFmpeg job under
 * that session id, and `export:cancel` resolves the session from its own
 * sender and cancels only that session's job — a second window's export
 * runs to completion untouched (jobs are process-per-export, so two
 * sessions can export concurrently). Export history stays app-global
 * shared preferences, not mid-export state.
 */
export function registerExportHandlers(
  resolve: (sender: SessionSender) => ExportRequestContext | null,
): void {
  const exporter = getExporter();

  ipcMain.handle('export:history', () => {
    return { success: true, history: loadExportHistory() };
  });

  // Renderer-baked advanced title layers (#525/#529): the renderer draws
  // each clip with the shared title renderer and ships PNG bytes; main only
  // persists them to a per-export directory it reports back for cleanup.
  ipcMain.handle('export:bake-titles', async (_event, payload: unknown) => {
    const files = (payload as { files?: unknown } | null)?.files;
    if (!Array.isArray(files) || files.length === 0 || files.length > 64) {
      return { success: false, error: 'Invalid bake payload.' };
    }
    const dir = path.join(
      app.getPath('userData'),
      'baked-titles',
      `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    try {
      await fs.mkdir(dir, { recursive: true });
      const paths: string[] = [];
      for (const file of files as Array<{ clipId?: unknown; bytes?: unknown }>) {
        if (typeof file.clipId !== 'string' || !(file.bytes instanceof ArrayBuffer)) {
          return { success: false, error: 'Invalid bake entry.' };
        }
        // A clip id is a nanoid, but never let it steer the filesystem.
        const safeName = file.clipId.replace(/[^A-Za-z0-9_-]/g, '_');
        const filePath = path.join(dir, `${safeName}.png`);
        await fs.writeFile(filePath, Buffer.from(file.bytes));
        paths.push(filePath);
      }
      return { success: true, dir, paths };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('export:start', async (event, options: ExportOptions) => {
    const ctx = resolve(event.sender);
    if (!ctx) return { success: false, error: 'No project loaded' };
    const { sessionId, project } = ctx;

    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { success: false, error: 'No window' };

    // Resolve the destination: an absolute path from the caller (agent/MCP)
    // is honored as-is; otherwise ask the user where to save.
    let outputPath = typeof options.outputPath === 'string' ? options.outputPath : '';
    if (!path.isAbsolute(outputPath)) {
      const ext = options.format === 'audio'
        ? 'm4a'
        : options.format === 'mov'
          ? 'mov'
          : options.format === 'webm'
            ? 'webm'
            : 'mp4';
      const dateTag = new Date().toISOString().slice(0, 10);
      const baseName = (project.name || 'export').replace(/[\\/:*?"<>|]/g, '_');
      const safeName = `${baseName}-${dateTag}`;
      const result = await dialog.showSaveDialog(win, {
        title: 'Export media',
        defaultPath: `${safeName}.${ext}`,
        filters:
          options.format === 'audio'
            ? [{ name: 'M4A audio', extensions: ['m4a'] }]
            : options.format === 'mov'
              ? [{ name: 'MOV video', extensions: ['mov'] }]
              : options.format === 'webm'
                ? [{ name: 'WebM video', extensions: ['webm'] }]
                : [{ name: 'MP4 video', extensions: ['mp4'] }],
      });
      if (result.canceled || !result.filePath) {
        return { success: false, canceled: true };
      }
      outputPath = result.filePath;
      options.outputPath = outputPath;
    }

    try {
      // Job keyed by this session: `export:cancel` from the same session
      // reaches it; another session's cancel or export never does.
      await exporter.export(project, options, win.webContents, sessionId);
      return { success: true, outputPath };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('export:cancel', (event) => {
    // Cancel strictly the requesting session's export (#137 Slice 3) — a
    // global flag here would kill whichever window happened to be encoding.
    const ctx = resolve(event.sender);
    if (ctx) exporter.cancel(ctx.sessionId);
    return { success: true };
  });

  ipcMain.handle('export:reveal', async (_event, outputPath: string) => {
    if (typeof outputPath === 'string' && outputPath.length > 0) {
      // `showItemInFolder` is fire-and-forget in Electron: it posts to a
      // worker thread and returns nothing, so a failure inside the shell is
      // dropped before it can reach us and this handler cannot observe one.
      // What we CAN know is whether the shell could resolve the containing
      // directory. Node stats it through the same filesystem Explorer reads,
      // so a directory we cannot open is one the shell cannot parse either.
      // Report that rather than a success nothing backs.
      const dir = path.dirname(outputPath);
      try {
        await fs.stat(dir);
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err);
        return { success: false, error: `Could not open ${dir}: ${reason}` };
      }
      shell.showItemInFolder(outputPath);
    }
    return { success: true };
  });
}
