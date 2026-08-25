/**
 * ExportPanel — the export workspace panel (#166): format/quality/resolution
 * options, real-time progress, and re-runnable delivery history, docked as a
 * column like Inspector or Agent so settings can be adjusted while a render
 * runs. Formerly a modal dialog; Ctrl+M / the title-bar button toggle it.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useTimelineStore } from '../store/timeline';
import { drawTitle, isAdvancedTitle } from '../engine/title-render';

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

const RESOLUTIONS = [
  { label: '1080p (1920×1080)', width: 1920, height: 1080 },
  { label: '720p (1280×720)', width: 1280, height: 720 },
  { label: '4K (3840×2160)', width: 3840, height: 2160 },
  { label: 'Project size', width: 0, height: 0 },
] as const;

export function ExportPanel({ onClose }: ExportPanelProps) {
  const projectWidth = useTimelineStore((s) => s.project.settings.width);
  const projectHeight = useTimelineStore((s) => s.project.settings.height);
  const projectFps = useTimelineStore((s) => s.getProjectFps());

  const [format, setFormat] = useState<Format>('mp4');
  const [quality, setQuality] = useState<Quality>('normal');
  const [resIdx, setResIdx] = useState(0);

  // Restore last-used export settings when the panel mounts.
  useEffect(() => {
    try {
      const saved = localStorage.getItem('palmier.export.settings');
      if (!saved) return;
      const parsed = JSON.parse(saved) as Partial<{ format: Format; quality: Quality; resIdx: number }>;
      if (parsed.format && ['mp4', 'mov', 'webm', 'audio'].includes(parsed.format)) {
        setFormat(parsed.format as Format);
      }
      if (parsed.quality && ['draft', 'normal', 'high'].includes(parsed.quality)) {
        setQuality(parsed.quality as Quality);
      }
      if (typeof parsed.resIdx === 'number' && parsed.resIdx >= 0 && parsed.resIdx < RESOLUTIONS.length) {
        setResIdx(parsed.resIdx);
      }
    } catch {
      // Corrupted settings fall through to defaults.
    }
  }, []);

  // Persist settings whenever they change while the panel is open.
  useEffect(() => {
    try {
      localStorage.setItem('palmier.export.settings',
        JSON.stringify({ format, quality, resIdx }));
    } catch { /* non-critical */ }
  }, [format, quality, resIdx]);

  const [hw, setHw] = useState<HwEncoder>('x264');
  const [hwAvailable, setHwAvailable] = useState<HwEncoder[]>([]);
  const [useRange, setUseRange] = useState(false);
  const inFrame = useTimelineStore((s) => s.project.timeline.inFrame);
  const outFrame = useTimelineStore((s) => s.project.timeline.outFrame);
  const hasRange = inFrame !== undefined && outFrame !== undefined && inFrame !== outFrame;
  const rangeStart = hasRange ? Math.min(inFrame!, outFrame!) : 0;
  const rangeEnd = hasRange ? Math.max(inFrame!, outFrame!) : 0;

  // Estimated duration: full timeline or the selected In/Out range.
  const clips = useTimelineStore((s) => s.project.timeline.clips);
  const durationFrames = useTimelineStore((s) => s.getProjectDuration());
  const effectiveDurationFrames = useRange && hasRange ? rangeEnd - rangeStart : durationFrames;
  const durationSec = effectiveDurationFrames / projectFps;
  const estimatedSizeMb = format === 'audio'
    ? (durationSec * 192 / 8 / 1024)
    : (() => {
      const bitrateMbps = quality === 'draft' ? 4 : quality === 'normal' ? 10 : 20;
      return (durationSec * bitrateMbps) / 8;
    })();
  const hasTitles = useTimelineStore((s) =>
    s.project.timeline.clips.some((c) => c.type === 'title' && c.text),
  );
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
    // of drawtext. A bake failure degrades those clips to solid styling
    // rather than blocking the export.
    let bakedTitles: Array<{ clipId: string; path: string }> | undefined;
    let bakedTempDir: string | undefined;
    const advanced = useTimelineStore
      .getState()
      .project.timeline.clips.filter(isAdvancedTitle);
    if (advanced.length > 0) {
      try {
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d')!;
        const files: Array<{ clipId: string; bytes: ArrayBuffer }> = [];
        for (const clip of advanced) {
          ctx.clearRect(0, 0, width, height);
          drawTitle(ctx, clip, { width, height });
          const blob = await canvas.convertToBlob({ type: 'image/png' });
          files.push({ clipId: clip.id, bytes: await blob.arrayBuffer() });
        }
        const res = await window.palmier.export.bakeTitles(files) as {
          success: boolean; dir?: string; paths?: string[]; error?: string;
        };
        if (res.success && res.dir && res.paths) {
          bakedTempDir = res.dir;
          bakedTitles = res.paths.map((path, index) => ({ clipId: advanced[index]!.id, path }));
        } else if (res.error) {
          console.warn('[export] title bake failed, falling back:', res.error);
        }
      } catch (err) {
        console.warn('[export] title bake failed, falling back:', err);
      }
    }

    const startRes = await window.palmier.export.start({
      outputPath: `output.${ext}`, // resolved by a save dialog in the main process
      format,
      quality,
      width,
      height,
      fps: projectFps,
      hw,
      ...(useRange && hasRange
        ? { range: { start: rangeStart, end: rangeEnd } }
        : {}),
      exportCaptions: exportCaptions && hasTitles,
      ...(bakedTitles ? { bakedTitles, bakedTempDir } : {}),
    });
    if (startRes && !startRes.success && startRes.canceled) {
      setIsExporting(false); // user closed the save dialog; not an error
    }
  }, [format, quality, hw, resIdx, projectWidth, projectHeight, projectFps, useRange, hasRange, rangeStart, rangeEnd]);

  const handleCancel = useCallback(async () => {
    await window.palmier.export.cancel();
    setIsExporting(false);
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

            {/* Format */}
            <div className="mb-4">
              <label className="block text-xs text-text-secondary mb-1.5">Format</label>
              <div className="flex gap-2">
                {(['mp4', 'mov', 'webm', 'audio'] as Format[]).map((f) => (
                  <OptionButton
                    key={f}
                    label={f === 'audio' ? 'AUDIO' : f.toUpperCase()}
                    selected={format === f}
                    onClick={() => setFormat(f)}
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

            {/* Encoder (MP4 only) */}
            {format === 'mp4' && hwAvailable.length > 1 && (
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

            {/* Error message */}
            {error && (
              <div className="mb-4 rounded bg-red-500/10 border border-red-500/30 px-3 py-2 text-xs text-red-400">
                {error}
              </div>
            )}

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
                      onClick={() => void window.palmier.export.reveal(r.outputPath)}
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
                  if (outputPath) void window.palmier.export.reveal(outputPath);
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
