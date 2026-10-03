/**
 * ExportPanel — the export workspace panel (#166): format/quality/resolution
 * options, real-time progress, and re-runnable delivery history, docked as a
 * column like Inspector or Agent so settings can be adjusted while a render
 * runs. Formerly a modal dialog; Ctrl+M / the title-bar button toggle it.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useTimelineStore } from '../store/timeline';
import { drawTitle } from '../engine/title-render';
import { drawShapeBox } from '../engine/shape-render';
import { hasShapeContent } from '../../shared/editor/shape';
import { isAdvancedTitle } from '../../shared/editor/title';
import { resolveRenderTimeline } from '../../shared/editor/compound';
import { exportFcpxmlWithReport } from '../../shared/fcpxml/exporter';
import type { Clip, Project } from '../../shared/types/project';

interface ExportPreset {
  id: string;
  name: string;
  format: 'mp4' | 'mov' | 'webm' | 'audio';
  quality: 'draft' | 'normal' | 'high';
  useRange: boolean;
}

interface ExportPanelProps {
  /** Hide the panel (the header close button, Cancel, Done, Escape). */
  onClose: () => void;
}

type Format = 'mp4' | 'mov' | 'webm' | 'audio';
type Quality = 'draft' | 'normal' | 'high';
type HwEncoder = 'x264' | 'nvenc' | 'qsv' | 'amf';
type HdrProfile = 'sdr' | 'hlg' | 'pq';

const HW_LABELS: Record<HwEncoder, string> = {
  x264: 'Software (x264)',
  nvenc: 'NVIDIA NVENC',
  qsv: 'Intel QSV',
  amf: 'AMD AMF',
};

interface ExportProgress {
  percent: number;
  frame: number;
  totalFrames: number;
  fps: number;
  eta: string;
}

interface ExportHistoryEntry {
  outputPath: string;
  format: string;
  quality: string;
  projectName: string;
  completedAt: string;
  bytes: number;
  options?: Record<string, unknown>;
}

/** What `media:fcpxml-write` answers: the written path plus the echoed report. */
interface FcpxmlWriteResult {
  success: boolean;
  path?: string;
  error?: string;
  canceled?: boolean;
  /** The exporter's omission notes, echoed back after the round trip. */
  unsupported?: string[];
}

const RESOLUTIONS = [
  { label: '1080p (1920×1080)', width: 1920, height: 1080 },
  { label: '720p (1280×720)', width: 1280, height: 720 },
  { label: '4K (3840×2160)', width: 3840, height: 2160 },
  { label: 'Project size', width: 0, height: 0 },
] as const;

/**
 * The message to put on the panel's error channel when a reveal did not reveal
 * anything, or `null` when it did.
 *
 * `export:reveal` used to answer `{ success: true }` for every path and the
 * panel never read the answer, so a failed reveal was indistinguishable from a
 * successful one. Only an explicit `success: false` counts as a failure: the
 * handler answers success for a non-path without calling the shell at all.
 */
export function revealFailureMessage(result: unknown): string | null {
  const res = result as { success?: boolean; error?: string } | null;
  if (res?.success) return null;
  return res?.error ?? 'Could not reveal the file in Explorer.';
}

/**
 * Does the render actually put caption text on screen? The panel gates the
 * sidecar on this so a project with no titles never writes an empty `.vtt`.
 *
 * The predicate reads the RESOLVED timeline — the same
 * `resolveRenderTimeline` the export graph consumes — so a title whose only
 * home is inside a compound clip counts. Reading `project.timeline.clips`
 * answered false for such a project, which suppressed the sidecar while the
 * title was plainly burned into the video. Compound resolution also applies
 * the same depth/cycle/window rules the render does, so a title the render
 * would not draw is a title the sidecar does not claim.
 */
export function hasCaptionTitles(project: Project): boolean {
  return resolveRenderTimeline(project).clips.some((clip) => clip.type === 'title' && clip.text);
}

/** The layers an export must rasterize before FFmpeg can composite them. */
export interface BakeCandidates {
  /** Advanced titles, in render order — baked full-canvas. */
  titles: Clip[];
  /** Shapes with drawable content, in render order — baked box-sized. */
  shapes: Clip[];
}

/**
 * The title/shape layers an export must rasterize, enumerated from the
 * RESOLVED timeline.
 *
 * The export graph consumes `resolveRenderTimeline(project)`
 * (`main/media/export-args.ts:307`) and looks each baked layer up by the
 * resolved clip id, so this reads the same resolved leaves rather than the raw
 * clip list. Merging the raw lists instead — main timeline plus one level of
 * `project.timelines` — is a different set at every depth, in both directions:
 *
 * - An advanced title bakes FULL-CANVAS and the graph overlays it with no x/y,
 *   so its position comes entirely from the PNG. Resolution composes a nested
 *   clip's geometry with its ancestors', and the raw merge handed `drawTitle`
 *   the stored inner clip, so a title inside a moved compound was rasterized —
 *   and exported — at the wrong place on the canvas. (A shape is unaffected: it
 *   bakes box-local content and the graph places the box.)
 * - `Object.values(project.timelines)` enumerates every nested timeline, so the
 *   raw merge also baked layers the render can never reach (orphaned, cyclic, or
 *   outside their compound's window): temp-dir writes for input paths no graph
 *   would ever consume.
 *
 * Resolution emits LEAVES only, so a compound clip is never a candidate — it has
 * no pixels of its own to rasterize. The titles and shapes it contains are
 * enumerated in its place.
 */
export function collectBakeCandidates(project: Project): BakeCandidates {
  const resolved = resolveRenderTimeline(project).clips;
  return {
    titles: resolved.filter(isAdvancedTitle),
    shapes: resolved.filter((clip) => clip.type === 'shape' && hasShapeContent(clip)),
  };
}

/** One rasterized layer, keyed by the clip id the export graph looks up. */
export interface BakedLayer {
  clipId: string;
  path: string;
}

/**
 * Rasterize every candidate with the exact renderers the preview draws with,
 * then hand the PNG bytes to main, which persists them to a per-export temp
 * directory it reports back for cleanup.
 *
 * Returns undefined when there is nothing to bake or the bake failed, so the
 * caller omits `bakedTitles`/`bakedTempDir` together and the graph runs its
 * documented fallbacks — solid-styled `drawtext` for titles, a reported skip
 * for shapes — rather than failing the export.
 */
export async function bakeExportLayers(
  project: Project,
  width: number,
  height: number,
): Promise<{ bakedTitles: BakedLayer[]; bakedTempDir: string } | undefined> {
  const { titles, shapes } = collectBakeCandidates(project);
  if (titles.length === 0 && shapes.length === 0) return undefined;
  try {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d')!;
    const files: Array<{ clipId: string; bytes: ArrayBuffer }> = [];
    for (const clip of titles) {
      ctx.clearRect(0, 0, width, height);
      drawTitle(ctx, clip, { width, height });
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      files.push({ clipId: clip.id, bytes: await blob.arrayBuffer() });
    }
    for (const clip of shapes) {
      const boxW = Math.max(1, Math.round(clip.width));
      const boxH = Math.max(1, Math.round(clip.height));
      const box = new OffscreenCanvas(boxW, boxH);
      const boxCtx = box.getContext('2d')!;
      boxCtx.clearRect(0, 0, boxW, boxH);
      drawShapeBox(boxCtx, clip, { width: boxW, height: boxH });
      const blob = await box.convertToBlob({ type: 'image/png' });
      files.push({ clipId: clip.id, bytes: await blob.arrayBuffer() });
    }
    const res = await window.palmier.export.bakeTitles(files) as {
      success: boolean; dir?: string; paths?: string[]; error?: string;
    };
    if (res.success && res.dir && res.paths) {
      return {
        bakedTitles: res.paths.map((path, index) => ({ clipId: files[index]!.clipId, path })),
        bakedTempDir: res.dir,
      };
    }
    if (res.error) console.warn('[export] title bake failed, falling back:', res.error);
  } catch (err) {
    console.warn('[export] title bake failed, falling back:', err);
  }
  return undefined;
}

export function ExportPanel({ onClose }: ExportPanelProps) {
  const projectWidth = useTimelineStore((s) => s.project.settings.width);
  const projectHeight = useTimelineStore((s) => s.project.settings.height);
  const projectFps = useTimelineStore((s) => s.getProjectFps());

  const [format, setFormat] = useState<Format>('mp4');
  const [quality, setQuality] = useState<Quality>('normal');
  const [resIdx, setResIdx] = useState(0);
  // HDR profile (upstream #59); 'sdr' is the unchanged Rec.709 8-bit path.
  const [hdr, setHdr] = useState<HdrProfile>('sdr');

  // Restore last-used export settings when the panel mounts.
  useEffect(() => {
    try {
      const saved = localStorage.getItem('palmier.export.settings');
      if (!saved) return;
      const parsed = JSON.parse(saved) as Partial<{ format: Format; quality: Quality; resIdx: number; hdr: HdrProfile }>;
      const restoredFormat =
        parsed.format && ['mp4', 'mov', 'webm', 'audio'].includes(parsed.format)
          ? parsed.format
          : 'mp4';
      setFormat(restoredFormat);
      if (parsed.quality && ['draft', 'normal', 'high'].includes(parsed.quality)) {
        setQuality(parsed.quality as Quality);
      }
      if (typeof parsed.resIdx === 'number' && parsed.resIdx >= 0 && parsed.resIdx < RESOLUTIONS.length) {
        setResIdx(parsed.resIdx);
      }
      // Narrow-on-read: only known profiles on HDR-capable formats restore;
      // anything else falls through to the SDR default.
      if (
        (restoredFormat === 'mp4' || restoredFormat === 'mov')
        && (parsed.hdr === 'hlg' || parsed.hdr === 'pq')
      ) {
        setHdr(parsed.hdr);
      }
    } catch {
      // Corrupted settings fall through to defaults.
    }
  }, []);

  // Persist settings whenever they change while the panel is open.
  useEffect(() => {
    try {
      localStorage.setItem('palmier.export.settings',
        JSON.stringify({ format, quality, resIdx, hdr }));
    } catch { /* non-critical */ }
  }, [format, quality, resIdx, hdr]);

  const [hw, setHw] = useState<HwEncoder>('x264');
  const [hwAvailable, setHwAvailable] = useState<HwEncoder[]>([]);
  const [useRange, setUseRange] = useState(false);
  const inFrame = useTimelineStore((s) => s.project.timeline.inFrame);
  const outFrame = useTimelineStore((s) => s.project.timeline.outFrame);
  const hasRange = inFrame !== undefined && outFrame !== undefined && inFrame !== outFrame;
  const rangeStart = hasRange ? Math.min(inFrame!, outFrame!) : 0;
  const rangeEnd = hasRange ? Math.max(inFrame!, outFrame!) : 0;

  // Estimated duration: full timeline or the selected In/Out range.
  const durationFrames = useTimelineStore((s) => s.getProjectDuration());
  const effectiveDurationFrames = useRange && hasRange ? rangeEnd - rangeStart : durationFrames;
  const durationSec = effectiveDurationFrames / projectFps;
  const estimatedSizeMb = format === 'audio'
    ? (durationSec * 192 / 8 / 1024)
    : (() => {
      const bitrateMbps = quality === 'draft' ? 4 : quality === 'normal' ? 10 : 20;
      return (durationSec * bitrateMbps) / 8;
    })();
  const hasTitles = useTimelineStore((s) => hasCaptionTitles(s.project));
  const [exportCaptions, setExportCaptions] = useState(true);
  const [presets, setPresets] = useState<ExportPreset[]>([]);
  const [recentExports, setRecentExports] = useState<ExportHistoryEntry[]>([]);
  const [isExporting, setIsExporting] = useState(false);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outputPath, setOutputPath] = useState<string | null>(null);
  const [outputBytes, setOutputBytes] = useState<number | null>(null);
  const res = RESOLUTIONS[resIdx];
  const width = res.width || projectWidth;
  const height = res.height || projectHeight;

  // Subscribe to export events for as long as the panel is mounted.
  useEffect(() => {
    const unsubProgress = window.palmier.on('export:progress', (data: unknown) => {
      setProgress(data as ExportProgress);
    });
    const unsubComplete = window.palmier.on('export:complete', (data: unknown) => {
      const d = data as { outputPath: string; bytes: number };
      setOutputPath(d.outputPath);
      setOutputBytes(d.bytes ?? null);
      setIsExporting(false);
    });
    const unsubError = window.palmier.on('export:error', (msg: unknown) => {
      setError(msg as string);
      setIsExporting(false);
    });

    return () => {
      unsubProgress();
      unsubComplete();
      unsubError();
    };
  }, []);

  // Load saved presets, export history, and detect HW encoders on mount.
  useEffect(() => {
    let cancelled = false;
    void window.palmier.media.hwEncoders().then((res: unknown) => {
      const r = res as { encoders?: HwEncoder[] } | undefined;
      if (!cancelled && r?.encoders) setHwAvailable(['x264', ...r.encoders]);
    });
    void window.palmier.export.getHistory().then((res: unknown) => {
      const r = res as { history?: ExportHistoryEntry[] } | undefined;
      if (r?.history) setRecentExports(r.history);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load saved presets once per mount.
  useEffect(() => {
    void window.palmier.media.getPresets().then((res: unknown) => {
      const r = res as { presets?: ExportPreset[] } | undefined;
      if (r?.presets) setPresets(r.presets);
    });
  }, []);

  const applyPreset = useCallback((preset: ExportPreset) => {
    setFormat(preset.format);
    setQuality(preset.quality);
    setUseRange(preset.useRange && hasRange);
  }, [hasRange]);

  const savePreset = useCallback(() => {
    const name = `My ${format.toUpperCase()} ${quality}`;
    const preset: ExportPreset = {
      id: `${Date.now()}`,
      name,
      format,
      quality,
      useRange,
    };
    const next = [...presets, preset];
    setPresets(next);
    void window.palmier.media.setPresets(next);
  }, [presets, format, quality, useRange]);

  const deletePreset = useCallback((id: string) => {
    const next = presets.filter((p) => p.id !== id);
    setPresets(next);
    void window.palmier.media.setPresets(next);
  }, [presets]);

  const handleExport = useCallback(async () => {
    setError(null);
    setOutputPath(null);
    setProgress(null);
    setIsExporting(true);

    const ext =
      format === 'audio' ? 'm4a' : format === 'mov' ? 'mov' : format === 'webm' ? 'webm' : 'mp4';

    // Advanced titles (#525/#529) bake to full-canvas RGBA PNGs using the
    // exact renderer the preview draws with; export composites these instead
    // of drawtext. Shape clips bake the same way but box-sized — the shared
    // shape renderer draws box content, and export overlays it at the clip
    // box like a decoded frame. Candidates come from the resolved timeline, so
    // a layer nested any depth deep is baked under the same clip id the export
    // graph looks up. A bake failure degrades those clips to solid styling
    // (titles) or skips them (shapes) rather than blocking the export.
    const project = useTimelineStore.getState().project;
    const baked = await bakeExportLayers(project, width, height);

    const startRes = await window.palmier.export.start({
      outputPath: `output.${ext}`, // resolved by a save dialog in the main process
      format,
      quality,
      width,
      height,
      fps: projectFps,
      hw,
      ...(hdr !== 'sdr' ? { hdr } : {}),
      ...(useRange && hasRange
        ? { range: { start: rangeStart, end: rangeEnd } }
        : {}),
      exportCaptions: exportCaptions && hasTitles,
      ...(baked ? { bakedTitles: baked.bakedTitles, bakedTempDir: baked.bakedTempDir } : {}),
    });
    if (startRes && !startRes.success && startRes.canceled) {
      setIsExporting(false); // user closed the save dialog; not an error
    }
  }, [format, quality, hw, hdr, resIdx, projectWidth, projectHeight, projectFps, useRange, hasRange, rangeStart, rangeEnd]);

  const handleCancel = useCallback(async () => {
    await window.palmier.export.cancel();
    setIsExporting(false);
  }, []);

  // A reveal used to be fired and forgotten, so a failed one was reported as a
  // completed one. Await the answer and put any failure on the panel's error
  // channel, which the completion view renders too.
  const handleReveal = useCallback(async (target: string) => {
    setError(null);
    const failure = revealFailureMessage(await window.palmier.export.reveal(target));
    if (failure) setError(failure);
  }, []);

  // ─── Interchange XML (#154) ──────────────────────────────────────────────
  const [xmlNote, setXmlNote] = useState('');
  const [xmlOmissions, setXmlOmissions] = useState<XmlOmissionSummary | null>(null);
  const handleExportXml = useCallback(async () => {
    setXmlNote('');
    setXmlOmissions(null);
    try {
      // The exporter owns the omission report, so ask it for the whole
      // structured result rather than only the XML body.
      const report = exportFcpxmlWithReport(useTimelineStore.getState().project);
      const res = await window.palmier.media.writeFcpxml({
        xml: report.xml,
        unsupported: report.unsupported,
      }) as FcpxmlWriteResult;
      if (res.success && res.path) {
        setXmlNote(`Written to ${res.path}`);
        // Main narrows and echoes the notes back, so the round trip is still
        // the exporter's report; fall back to it if a response omits them.
        setXmlOmissions(summarizeXmlOmissions(res.unsupported ?? report.unsupported));
      } else if (!res.canceled) setError(res.error ?? 'Could not write the XML file.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not write the XML file.');
    }
  }, []);

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
      <div className="panel-header flex h-9 shrink-0 items-center justify-between border-b border-white/10 px-2 text-[10px] font-medium text-text-primary">
        <span>Export</span>
        <button
          onClick={onClose}
          title="Hide export panel"
          aria-label="Hide export panel"
          className="rounded p-0.5 text-text-muted hover:bg-white/10 hover:text-text-primary"
        >
          ✕
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">

        {/* Error message — shared by every view, so a failed reveal in the
            completion view is as visible as a failed export in the setup one. */}
        {error && (
          <div className="mb-4 rounded bg-red-500/10 border border-red-500/30 px-3 py-2 text-xs text-red-400">
            {error}
          </div>
        )}

        {!isExporting && !outputPath ? (
          <>
            {/* Presets */}
            {presets.length > 0 && (
              <div className="mb-4">
                <label className="block text-xs text-text-secondary mb-1.5">Presets</label>
                <select
                  onChange={(e) => {
                    const preset = presets.find((p) => p.id === e.target.value);
                    if (preset) applyPreset(preset);
                  }}
                  defaultValue=""
                  className="w-full rounded border border-surface-3 bg-surface-2 px-3 py-1.5 text-sm text-text-primary"
                >
                  <option value="">Choose a preset…</option>
                  {presets.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Interchange (#154): project XML for Resolve / FCP / Premiere */}
            <div className="mb-4">
              <button
                onClick={handleExportXml}
                disabled={isExporting}
                data-export-xml
                className="w-full rounded border border-surface-3 bg-surface-2 px-3 py-1.5 text-xs text-text-secondary transition hover:border-surface-4 hover:text-text-primary disabled:opacity-40"
              >
                Export project XML (Final Cut)…
              </button>
              {xmlNote && <XmlExportReport note={xmlNote} summary={xmlOmissions} />}
            </div>

            {/* Format */}
            <div className="mb-4">
              <label className="block text-xs text-text-secondary mb-1.5">Format</label>
              <div className="flex gap-2">
                {(['mp4', 'mov', 'webm', 'audio'] as Format[]).map((f) => (
                  <OptionButton
                    key={f}
                    label={f === 'audio' ? 'AUDIO' : f.toUpperCase()}
                    selected={format === f}
                    onClick={() => {
                      setFormat(f);
                      // HDR is an MP4/MOV delivery; narrow back to SDR so the
                      // panel never requests a combination it would refuse.
                      if (f === 'webm' || f === 'audio') setHdr('sdr');
                    }}
                  />
                ))}
              </div>
            </div>

            {/* Quality */}
            <div className="mb-2">
              <label className="block text-xs text-text-secondary mb-1.5">Quality</label>
              <div className="flex gap-2">
                {(['draft', 'normal', 'high'] as Quality[]).map((q) => (
                  <OptionButton
                    key={q}
                    label={q.charAt(0).toUpperCase() + q.slice(1)}
                    selected={quality === q}
                    onClick={() => setQuality(q)}
                  />
                ))}
              </div>
              <p className="mt-1 text-[9px] text-text-muted">
                {quality === 'draft'
                  ? 'CRF 28 · fastest render, largest file'
                  : quality === 'normal'
                    ? 'CRF 20 · balanced quality and speed'
                    : 'CRF 16 · best quality, slowest render'}
              </p>
            </div>

            {/* Encoder (MP4 only, SDR only — HDR selects the software HEVC path) */}
            {format === 'mp4' && hdr === 'sdr' && hwAvailable.length > 1 && (
              <div className="mb-4">
                <label className="block text-xs text-text-secondary mb-1.5">Encoder</label>
                <select
                  value={hwAvailable.includes(hw) ? hw : 'x264'}
                  onChange={(e) => setHw(e.target.value as HwEncoder)}
                  className="w-full rounded border border-surface-3 bg-surface-2 px-3 py-1.5 text-sm text-text-primary"
                >
                  {hwAvailable.map((enc) => (
                    <option key={enc} value={enc}>
                      {HW_LABELS[enc] ?? enc}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* HDR (upstream #59): MP4/MOV only; existing select styling verbatim.
                Delivery-only: preview stays SDR Rec.709 — this does not re-tint
                the timeline preview, the conversion runs at encode time. */}
            {(format === 'mp4' || format === 'mov') && (
              <div className="mb-4">
                <label className="block text-xs text-text-secondary mb-1.5">HDR</label>
                <select
                  value={hdr}
                  onChange={(e) => {
                    const next = e.target.value as HdrProfile;
                    setHdr(next);
                    // HDR encodes through software HEVC Main10; the hardware
                    // selectors are 8-bit H.264 paths, so snap to software.
                    if (next !== 'sdr') setHw('x264');
                  }}
                  className="w-full rounded border border-surface-3 bg-surface-2 px-3 py-1.5 text-sm text-text-primary"
                >
                  <option value="sdr">Off (SDR · Rec.709 · 8-bit)</option>
                  <option value="hlg">HLG (BT.2020 · 10-bit)</option>
                  <option value="pq">PQ / HDR10 (BT.2020 · 10-bit)</option>
                </select>
              </div>
            )}

            {/* Resolution */}
            <div className="mb-6">
              <label className="block text-xs text-text-secondary mb-1.5">Resolution</label>
              <select
                value={resIdx}
                onChange={(e) => setResIdx(parseInt(e.target.value))}
                className="w-full rounded border border-surface-3 bg-surface-2 px-3 py-1.5 text-sm text-text-primary"
              >
                {RESOLUTIONS.map((r, i) => (
                  <option key={i} value={i}>
                    {r.label === 'Project size'
                      ? `Project size (${projectWidth}×${projectHeight})`
                      : r.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Range (In/Out marks) */}
            {hasRange && (
              <div className="mb-4">
                <label className="flex items-center gap-2 text-xs text-text-secondary">
                  <input
                    type="checkbox"
                    checked={useRange}
                    onChange={(e) => setUseRange(e.target.checked)}
                    className="accent-[var(--color-accent)]"
                  />
                  Export In/Out range only ({rangeStart}–{rangeEnd})
                </label>
              </div>
            )}

            {/* Captions sidecar (R3) */}
            {hasTitles && format !== 'audio' && (
              <div className="mb-4">
                <label className="flex items-center gap-2 text-xs text-text-secondary">
                  <input
                    type="checkbox"
                    checked={exportCaptions}
                    onChange={(e) => setExportCaptions(e.target.checked)}
                    className="accent-[var(--color-accent)]"
                  />
                  Export captions (.vtt sidecar)
                </label>
              </div>
            )}

            {/* Duration & estimated size */}
            <div className="mb-4 rounded border border-surface-3 bg-surface-2 px-3 py-2 text-xs text-text-secondary">
              <div className="flex justify-between">
                <span>Duration</span>
                <span className="font-mono">{Math.floor(durationSec / 60)}:{String(Math.round(durationSec % 60)).padStart(2, '0')}</span>
              </div>
              {format !== 'audio' && (
                <div className="flex justify-between">
                  <span>Resolution</span>
                  <span className="font-mono">{width}×{height}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span>Est. size</span>
                <span className="font-mono">
                  {estimatedSizeMb > 1024
                    ? `${(estimatedSizeMb / 1024).toFixed(1)} GB`
                    : `${Math.round(estimatedSizeMb)} MB`}
                </span>
              </div>
            </div>

            {/* Buttons */}
            <div className="flex justify-end gap-3">
              <button
                onClick={onClose}
                className="rounded px-4 py-2 text-sm text-text-secondary hover:bg-surface-3 transition"
              >
                Cancel
              </button>
              <button
                onClick={handleExport}
                className="rounded bg-accent px-4 py-2 text-sm font-medium text-surface-0 hover:bg-accent-hover transition"
              >
                Export
              </button>
            </div>
          </>
        ) : isExporting ? (
          /* Progress */
          <div>
            <div className="mb-3">
              <div className="flex justify-between text-xs text-text-secondary mb-1">
                <span>Exporting...</span>
                <span>{progress?.percent || 0}%</span>
              </div>
              <div className="h-2 rounded-full bg-surface-3 overflow-hidden">
                <div
                  className="h-full bg-accent transition-all duration-300"
                  style={{ width: `${progress?.percent || 0}%` }}
                />
              </div>
            </div>
            <div className="flex justify-between text-2xs text-text-muted mb-4">
              <span>Frame {progress?.frame || 0} / {progress?.totalFrames || '?'}</span>
              <span>{progress?.fps ? `${progress.fps.toFixed(1)} fps` : ''}</span>
              <span>{progress?.eta ? `ETA: ${progress.eta}` : ''}</span>
            </div>
            <div className="flex justify-end">
              <button
                onClick={handleCancel}
                className="rounded border border-red-500/50 px-4 py-2 text-sm text-red-400 hover:bg-red-500/10 transition"
              >
                Cancel Export
              </button>
            </div>
          </div>
        ) : (
          /* Complete */
          <div>
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/20">
                <span className="text-xl">✓</span>
              </div>
              <div>
                <p className="text-sm text-text-primary">Export complete</p>
                <p className="text-2xs text-text-muted truncate max-w-[280px]">{outputPath}</p>
                {outputBytes !== null && (
                  <p className="text-2xs text-text-secondary">
                    {outputBytes > 1_048_576
                      ? `${(outputBytes / 1_048_576).toFixed(1)} MB`
                      : `${Math.round(outputBytes / 1024)} KB`}
                  </p>
                )}
              </div>
            </div>
            {recentExports.length > 1 && (
              <div className="mb-4">
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-text-muted">Recent deliveries</p>
                {recentExports.slice(0, 5).map((r, i) => (
                  <div key={i} className="flex items-center gap-2 rounded px-1 py-0.5 text-[9px] text-text-muted hover:bg-white/[0.04]">
                    <button
                      onClick={() => void handleReveal(r.outputPath)}
                      className="min-w-0 flex-1 truncate text-left hover:text-text-secondary"
                      title={`Reveal ${r.outputPath}`}
                    >
                      {r.projectName} · {r.format.toUpperCase()} · {r.quality} · {new Date(r.completedAt).toLocaleDateString()}
                    </button>
                    {r.options && (
                      <button
                        onClick={() => {
                          void window.palmier.export.start({ ...r.options, outputPath: `output.${r.format === 'audio' ? 'm4a' : r.format}` });
                          setIsExporting(true);
                        }}
                        className="shrink-0 rounded border border-white/15 px-1.5 py-0.5 text-[8px] text-text-secondary hover:bg-white/[0.06] hover:text-text-primary"
                        title="Re-run with the same settings"
                      >
                        Re-run
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  if (outputPath) void handleReveal(outputPath);
                }}
                className="rounded border border-surface-3 px-4 py-2 text-sm text-text-secondary hover:bg-surface-3 transition"
              >
                Reveal in Explorer
              </button>
              <button
                onClick={onClose}
                  className="rounded bg-accent px-4 py-2 text-sm font-medium text-surface-0 hover:bg-accent-hover transition"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function OptionButton({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 rounded border px-3 py-1.5 text-xs font-medium transition ${
        selected
          ? 'border-accent bg-accent/10 text-accent'
          : 'border-surface-3 bg-surface-2 text-text-secondary hover:border-surface-4'
      }`}
    >
      {label}
    </button>
  );
}

// ─── FCPXML omission report (#154) ──────────────────────────────────────────

/** Clip ids named per row before the "+N more" tail takes over. */
const MAX_LISTED_SUBJECTS = 3;
/** Rows drawn before the "+N more kinds" tail takes over. */
const MAX_OMISSION_ROWS = 6;

/** `<Kind> "id" <rest>` — the exporter names every subject it reports. */
const OMITTED_SUBJECT = /^(.*?)"([^"]+)"\s+(.*)$/;
/** Property notes read `carries <property>; <why the format has no form>`. */
const OMITTED_PROPERTY = /^carries (?:an? )?([^,;]+)[,;]/;

/** One reason a subject is absent from the written XML, collapsed to a row. */
export interface XmlOmissionGroup {
  /** Subject kind plus label, so distinct reasons never share a row. */
  key: string;
  /** What was left out, in the exporter's own words. */
  label: string;
  /** The first note verbatim, kept for the row's tooltip. */
  note: string;
  /** Notes carrying this label. */
  count: number;
  /** Subject kind as the exporter names it: "clip" / "clips". */
  singular: string;
  plural: string;
  /** Up to MAX_LISTED_SUBJECTS ids, in first-seen order. */
  subjects: string[];
  /** Subjects beyond the listed ones. */
  moreSubjects: number;
}

export interface XmlOmissionSummary {
  /** Every note the exporter reported. */
  total: number;
  /** Distinct clips, titles and groups behind those notes. */
  subjectCount: number;
  /** Reasons, in the order the exporter reported them. */
  groups: XmlOmissionGroup[];
}

/**
 * Group the exporter's `unsupported[]` notes for display. This only reshapes
 * what the exporter already decided — the wording is its contract
 * (shared/fcpxml/exporter.ts:396-450) — so a project with a hundred graded
 * clips reads as one row instead of a hundred lines. A note with no quoted
 * subject is passed through whole rather than dropped.
 */
export function summarizeXmlOmissions(notes: readonly string[]): XmlOmissionSummary {
  const byKey = new Map<string, XmlOmissionGroup>();
  const subjects = new Set<string>();
  for (const note of notes) {
    const parsed = parseOmissionNote(note);
    if (parsed.id) subjects.add(parsed.id);
    const key = `${parsed.singular}::${parsed.label}`;
    const group = byKey.get(key);
    if (group) {
      group.count += 1;
      if (parsed.id && !group.subjects.includes(parsed.id)) {
        if (group.subjects.length < MAX_LISTED_SUBJECTS) group.subjects.push(parsed.id);
        else group.moreSubjects += 1;
      }
      continue;
    }
    byKey.set(key, {
      key,
      label: parsed.label,
      note,
      count: 1,
      singular: parsed.singular,
      plural: parsed.plural,
      subjects: parsed.id ? [parsed.id] : [],
      moreSubjects: 0,
    });
  }
  return { total: notes.length, subjectCount: subjects.size, groups: [...byKey.values()] };
}

function parseOmissionNote(note: string): {
  singular: string;
  plural: string;
  label: string;
  id: string;
} {
  const subject = OMITTED_SUBJECT.exec(note);
  if (!subject) return { singular: 'item', plural: 'items', label: note, id: '' };
  const kind = lowerFirst(subject[1]!.trim());
  const rest = subject[3]!;
  const property = OMITTED_PROPERTY.exec(rest);
  return {
    singular: kind,
    plural: `${kind}s`,
    label: property ? property[1]!.trim() : omissionReason(rest),
    id: subject[2]!,
  };
}

/** The explanatory clause, or the first one when it only says "it is skipped". */
function omissionReason(rest: string): string {
  const [first, ...clauses] = rest.split(';').map((part) => part.trim());
  const why = clauses.join(';').trim();
  return why && !/^it is skipped\b/i.test(why) ? why : first!.trim();
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

/**
 * The write result, plus what Final Cut XML could not carry. The exporter
 * declines to transport grade, effects, blend modes, fades and edge
 * treatments, and skips clip kinds with no FCPXML form, reporting each in
 * `FcpxmlExportResult.unsupported`. This is a property of the format target,
 * not a failure — the file exists — so it never takes the error line.
 */
export function XmlExportReport({
  note,
  summary,
}: {
  note: string;
  summary: XmlOmissionSummary | null;
}) {
  const total = summary?.total ?? 0;
  const subjects = summary?.subjectCount ?? 0;
  const groups = summary?.groups ?? [];
  return (
    <div data-export-xml-result>
      <p className="mt-1 flex items-center gap-1.5 text-[10px] text-emerald-400">
        ✓ {note}
      </p>
      {groups.length > 0 && (
        <div
          data-export-xml-omissions
          className="mt-1.5 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[10px] leading-relaxed text-amber-300"
        >
          <p>
            {`Final Cut XML cannot represent ${total} of these across ${subjects} `
              + `${subjects === 1 ? 'item' : 'items'}. The file was written without them.`}
          </p>
          <ul className="mt-1 space-y-0.5">
            {groups.slice(0, MAX_OMISSION_ROWS).map((group) => (
              <li key={group.key} title={group.note}>
                <span className="font-medium">{group.label}</span>
                {` · ${group.count} ${group.count === 1 ? group.singular : group.plural}`}
                {group.subjects.length > 0 && (
                  <>
                    {' · '}
                    {group.subjects.join(', ')}
                    {group.moreSubjects > 0 && ` +${group.moreSubjects} more`}
                  </>
                )}
              </li>
            ))}
          </ul>
          {groups.length > MAX_OMISSION_ROWS && (
            <p>{`+${groups.length - MAX_OMISSION_ROWS} more kinds`}</p>
          )}
        </div>
      )}
    </div>
  );
}
