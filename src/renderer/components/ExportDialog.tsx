/**
 * ExportDialog — modal for configuring and running video export.
 * Shows format/quality/resolution options and real-time progress.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useTimelineStore } from '../store/timeline';

interface ExportDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

type Format = 'mp4' | 'mov' | 'webm';
type Quality = 'draft' | 'normal' | 'high';

interface ExportProgress {
  percent: number;
  frame: number;
  totalFrames: number;
  fps: number;
  eta: string;
}

const RESOLUTIONS = [
  { label: '1080p (1920×1080)', width: 1920, height: 1080 },
  { label: '720p (1280×720)', width: 1280, height: 720 },
  { label: '4K (3840×2160)', width: 3840, height: 2160 },
  { label: 'Project size', width: 0, height: 0 },
] as const;

export function ExportDialog({ isOpen, onClose }: ExportDialogProps) {
  const projectWidth = useTimelineStore((s) => s.project.settings.width);
  const projectHeight = useTimelineStore((s) => s.project.settings.height);
  const projectFps = useTimelineStore((s) => s.getProjectFps());

  const [format, setFormat] = useState<Format>('mp4');
  const [quality, setQuality] = useState<Quality>('normal');
  const [resIdx, setResIdx] = useState(0);
  const [isExporting, setIsExporting] = useState(false);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outputPath, setOutputPath] = useState<string | null>(null);

  // Subscribe to export events
  useEffect(() => {
    if (!isOpen) return;

    const unsubProgress = window.palmier.on('export:progress', (data: unknown) => {
      setProgress(data as ExportProgress);
    });
    const unsubComplete = window.palmier.on('export:complete', (data: unknown) => {
      const d = data as { outputPath: string };
      setOutputPath(d.outputPath);
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
  }, [isOpen]);

  const handleExport = useCallback(async () => {
    setError(null);
    setOutputPath(null);
    setProgress(null);
    setIsExporting(true);

    const res = RESOLUTIONS[resIdx];
    const width = res.width || projectWidth;
    const height = res.height || projectHeight;

    const ext = format === 'mov' ? 'mov' : format === 'webm' ? 'webm' : 'mp4';

    await window.palmier.export.start({
      outputPath: `output.${ext}`, // TODO: file dialog
      format,
      quality,
      width,
      height,
      fps: projectFps,
    });
  }, [format, quality, resIdx, projectWidth, projectHeight, projectFps]);

  const handleCancel = useCallback(async () => {
    await window.palmier.export.cancel();
    setIsExporting(false);
  }, []);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[420px] rounded-lg border border-surface-3 bg-surface-1 p-6 shadow-2xl animate-fade-in">
        <h2 className="text-lg font-medium text-text-primary mb-4">Export Video</h2>

        {!isExporting && !outputPath ? (
          <>
            {/* Format */}
            <div className="mb-4">
              <label className="block text-xs text-text-secondary mb-1.5">Format</label>
              <div className="flex gap-2">
                {(['mp4', 'mov', 'webm'] as Format[]).map((f) => (
                  <OptionButton
                    key={f}
                    label={f.toUpperCase()}
                    selected={format === f}
                    onClick={() => setFormat(f)}
                  />
                ))}
              </div>
            </div>

            {/* Quality */}
            <div className="mb-4">
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
            </div>

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
                className="rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover transition"
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
              </div>
            </div>
            <div className="flex justify-end">
              <button
                onClick={onClose}
                className="rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover transition"
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
