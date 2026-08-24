/**
 * TimelineClip — a single clip rendered on a track lane.
 * Supports: selection, drag-to-move, trim handles (left/right edges),
 * and a context menu ("Save as audio" bakes the clip's trimmed source
 * window into a standalone library asset, upstream PR #562).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Clip } from '../../../shared/types/project';
import { useTimelineStore } from '../../store/timeline';
import {
  resolveClipHitZone,
  showsTrimHandles,
} from '../../lib/timeline-clip-hit';
import { clipTrimSeconds } from '../../../shared/media/source-time';
import { slicePeaks } from '../../../shared/audio/waveform';
import { getWaveformPeaks } from '../../lib/waveform-cache';
import { filmstripLayout } from '../../../shared/media/filmstrip';
import { getFilmstrip } from '../../lib/filmstrip-cache';
import { normalizeGain } from '../../../shared/audio/normalize';
import { useMediaPanelStore } from '../../store/media-panel';

interface TimelineClipProps {
  clip: Clip;
}

const CLIP_COLORS: Record<string, string> = {
  video: 'bg-indigo-600/80 border-indigo-400/50',
  audio: 'bg-emerald-600/80 border-emerald-400/50',
  image: 'bg-amber-600/80 border-amber-400/50',
  title: 'bg-pink-600/80 border-pink-400/50',
  generated: 'bg-purple-600/80 border-purple-400/50',
};

export function TimelineClip({ clip }: TimelineClipProps) {
  const viewport = useTimelineStore((s) => s.viewport);
  const selectedClipIds = useTimelineStore((s) => s.selectedClipIds);
  const hoveredClipId = useTimelineStore((s) => s.hoveredClipId);
  const selectClip = useTimelineStore((s) => s.selectClip);
  const setHoveredClip = useTimelineStore((s) => s.setHoveredClip);
  const startDrag = useTimelineStore((s) => s.startDrag);

  const clipRef = useRef<HTMLDivElement>(null);

  const isSelected = selectedClipIds.has(clip.id);
  const isHovered = hoveredClipId === clip.id;

  // ─── Save as audio (#562) ────────────────────────────────────────────────
  const fps = useTimelineStore((s) => s.getProjectFps());
  const settingsHeight = useTimelineStore((s) => s.project.settings.height);
  const asset = useTimelineStore((s) => s.project.media.find((m) => m.id === clip.assetId));
  const isOffline = useTimelineStore(
    (s) => Boolean(asset && s.offlinePaths.has(asset.path)),
  );
  const canSaveAudio =
    (clip.type === 'video' || clip.type === 'audio') && Boolean(asset?.audioCodec);
  // Viewport-fixed coordinates: the clip body is overflow-hidden, which would
  // clip an absolutely-positioned menu on short clips.
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);

  // ─── Detach / relink audio (#462 surface) ─────────────────────────────────
  const controller = useTimelineStore((s) => s.controller);
  const setClipSpeed = useTimelineStore((s) => s.setClipSpeed);
  const setClipPan = useTimelineStore((s) => s.setClipPan);
  const duplicateSelected = useTimelineStore((s) => s.duplicateSelected);
  const selectedCount = selectedClipIds.size;

  // ─── Normalize audio (R5) ────────────────────────────────────────────────
  const [normalizing, setNormalizing] = useState(false);
  async function handleNormalize() {
    setMenuPos(null);
    if (!asset) return;
    setNormalizing(true);
    try {
      const analysis = await window.palmier.media.volumeAnalysis(asset.path);
      if (!analysis.success) {
        console.warn('[normalize]', analysis.error);
        return;
      }
      // Target −3 dBFS peak; gain is applied through clip volume.
      const targetDb = -3;
      const currentPeakDb = analysis.maxVolumeDb ?? 0;
      const gain = normalizeGain(currentPeakDb, targetDb);
      const newVolume = Math.min(1, Math.max(0, (clip.volume ?? 1) * gain));
      controller.applyClipProperties(
        [clip.id],
        'Normalize audio',
        (draft) => {
          draft.volume = newVolume;
          return true;
        },
      );
    } finally {
      setNormalizing(false);
    }
  }

  const canDetach = clip.linkGroupId !== undefined;
  const canRelink =
    isSelected && selectedCount >= 2
    && new Set(
      controller
        .getClips()
        .filter((c) => selectedClipIds.has(c.id))
        .map((c) => c.type),
    ).size >= 2;

  const handleDetachAudio = useCallback(() => {
    setMenuPos(null);
    try {
      controller.unlinkClips([clip.id]);
    } catch {
      // Refusals (nothing linked, locked track) are non-actionable here.
    }
  }, [controller, clip.id]);

  const handleLinkSelected = useCallback(() => {
    setMenuPos(null);
    try {
      controller.linkClips([...selectedClipIds]);
    } catch {
      // Upstream's refusal messages do not belong in a toast on right-click.
    }
  }, [controller, selectedClipIds]);

  // ─── Audio waveform (R1 lane states) ─────────────────────────────────────
  const WAVEFORM_BUCKETS = 256;
  const FILMSTRIP_COUNT = 8;
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [strip, setStrip] = useState<string[] | null>(null);
  const audioPath = clip.type === 'audio' && !isOffline ? asset?.path : undefined;
  const videoPath = clip.type === 'video' && !isOffline ? asset?.path : undefined;

  useEffect(() => {
    if (!audioPath) {
      setPeaks(null);
      return;
    }
    let cancelled = false;
    const promise = getWaveformPeaks(audioPath, WAVEFORM_BUCKETS);
    if (!promise) {
      setPeaks(null);
      return;
    }
    promise
      .then((curve) => {
        if (!cancelled) setPeaks(curve);
      })
      .catch(() => {
        if (!cancelled) setPeaks(null);
      });
    return () => {
      cancelled = true;
    };
  }, [audioPath]);

  useEffect(() => {
    if (!videoPath) {
      setStrip(null);
      return;
    }
    let cancelled = false;
    const promise = getFilmstrip(videoPath, FILMSTRIP_COUNT);
    if (!promise) {
      setStrip(null);
      return;
    }
    promise
      .then((paths) => {
        if (!cancelled) setStrip(paths);
      })
      .catch(() => {
        if (!cancelled) setStrip(null);
      });
    return () => {
      cancelled = true;
    };
  }, [videoPath]);




  // ─── Paste attributes (R1 checklist) ─────────────────────────────────────
  const [, setSnapshotVersion] = useState(0);
  const settingsSnapshot = controller.getSettingsSnapshot();
  const snapshotMatches =
    settingsSnapshot !== null
    && settingsSnapshot.kind === clip.type
    && settingsSnapshot.sourceId !== clip.id;

  const handleCopySettings = useCallback(() => {
    setMenuPos(null);
    if (controller.copySettingsSnapshot(clip.id)) setSnapshotVersion((v) => v + 1);
  }, [controller, clip.id]);

  const pasteWith = useCallback(
    (fields?: Array<'transform' | 'opacity' | 'blendMode' | 'volume'>) => {
      setMenuPos(null);
      try {
        controller.pasteSettingsFromSnapshot([clip.id], fields);
      } catch {
        // Kind/unknown refusals are non-actionable from the menu.
      }
      setSnapshotVersion((v) => v + 1);
    },
    [controller, clip.id],
  );

  // Position and size
  const left = (clip.startFrame - viewport.scrollFrame) * viewport.pixelsPerFrame;
  const width = clip.durationFrames * viewport.pixelsPerFrame;

  /** Visible filmstrip slots for the clip's trimmed window. */
  const stripSlots = useMemo(() => {
    if (clip.type !== 'video' || !strip || width < 24) return null;
    const totalSeconds = asset ? Math.max(0.04, asset.duration / fps) : 1;
    const startSec = clip.inPoint / fps;
    const endSec = clip.outPoint / fps;
    return filmstripLayout(strip.length, totalSeconds, startSec, endSec).map(
      (slot) => ({ ...slot, src: strip[slot.index] }),
    );
  }, [clip.type, strip, width, asset, fps, clip.inPoint, clip.outPoint]);

  // Waveform bars for the clip's trimmed window (audio clips, R1).
  const waveformBars = useMemo(() => {
    if (clip.type !== 'audio' || !peaks || width < 8) return null;
    const totalSeconds = asset ? Math.max(1, asset.duration / fps) : 1;
    const startRatio = clip.inPoint / fps / totalSeconds;
    const endRatio = clip.outPoint / fps / totalSeconds;
    return slicePeaks(
      peaks,
      startRatio,
      endRatio,
      Math.min(180, Math.max(8, Math.floor(width / 2))),
    );
  }, [clip.type, peaks, width, asset, fps, clip.inPoint, clip.outPoint]);

  // Color based on clip type
  const colorClass = CLIP_COLORS[clip.type] || CLIP_COLORS.video;

  // Fade ramp widths in pixels (visual handles on the clip).
  const fadeInPx = (clip.fadeInFrames ?? 0) * viewport.pixelsPerFrame;
  const fadeOutPx = (clip.fadeOutFrames ?? 0) * viewport.pixelsPerFrame;

  // ─── Mouse handlers ──────────────────────────────────────────────────────

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();

      // Determine if clicking on a trim handle
      const rect = clipRef.current?.getBoundingClientRect();
      if (!rect) return;

      const localX = e.clientX - rect.left;

      // Below the minimum width the trim zones would cover the whole body, so
      // the clip is move-only (#488); zoom in to trim precisely.
      const zone = resolveClipHitZone(localX, rect.width);
      if (zone === 'trim-left') {
        // Left trim handle — Alt scopes to this half only (J/L cuts)
        startDrag('trim-left', clip.id, e.clientX, clip.startFrame, e.shiftKey, e.altKey);
      } else if (zone === 'trim-right') {
        // Right trim handle
        startDrag('trim-right', clip.id, e.clientX, clip.startFrame, e.shiftKey, e.altKey);
      } else {
        // Body — move or select
        if (!isSelected) {
          selectClip(clip.id, e.ctrlKey || e.shiftKey, !e.altKey);
        }
        startDrag('move', clip.id, e.clientX, clip.startFrame);
      }
    },
    [clip.id, clip.startFrame, isSelected, selectClip, startDrag],
  );

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      selectClip(clip.id, e.ctrlKey || e.shiftKey, !e.altKey);
    },
    [clip.id, selectClip],
  );

  // ─── Title inline editing (R3) ───────────────────────────────────────────
  const setTitleText = useTimelineStore((s) => s.setTitleText);
  const [editingTitle, setEditingTitle] = useState<string | null>(null);
  const [titleFontSize, setTitleFontSize] = useState<string>('');
  const [titleColor, setTitleColor] = useState<string>('');
  const titleInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingTitle !== null) {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    }
  }, [editingTitle]);

  const startTitleEdit = useCallback(() => {
    setEditingTitle(clip.text ?? 'Title');
    setTitleFontSize(String(Math.round((clip.titleSizeRatio ?? 0.09) * settingsHeight)));
    setTitleColor(clip.titleColor ?? '#ffffff');
  }, [clip]);

  const commitTitle = useCallback(() => {
    if (editingTitle === null) return;
    setTitleText(clip.id, editingTitle);
    const ratio = parseFloat(titleFontSize) / settingsHeight;
    if (Number.isFinite(ratio) && ratio > 0 && Math.abs(ratio - (clip.titleSizeRatio ?? 0)) > 0.001) {
      useTimelineStore.getState().controller.applyClipProperties(
        [clip.id], 'Resize title', (draft) => { draft.titleSizeRatio = ratio; return true; },
      );
    }
    if (titleColor && /^#[0-9a-fA-F]{6}$/.test(titleColor) && titleColor !== (clip.titleColor ?? '')) {
      useTimelineStore.getState().controller.applyClipProperties(
        [clip.id], 'Recolor title', (draft) => { draft.titleColor = titleColor; return true; },
      );
    }
    setEditingTitle(null);
  }, [editingTitle, titleFontSize, titleColor, clip, settingsHeight, setTitleText]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!isSelected) selectClip(clip.id);
      setMenuPos({ x: e.clientX, y: e.clientY });
    },
    [clip.id, isSelected, selectClip],
  );

  const handleSaveAudio = useCallback(async () => {
    setMenuPos(null);
    if (!asset) return;
    // The clip's trimmed source window, through the same mapping export uses
    // (#68), baked into the extracted file.
    const trim = clipTrimSeconds(clip, fps);
    const result = await window.palmier.media.extractAudio(asset.path, {
      startSec: trim.start,
      endSec: trim.end,
    });
    if (result.success) {
      useTimelineStore.getState().importAssets([result.asset]);
    } else {
      useMediaPanelStore.getState().setNotice(result.error);
    }
  }, [asset, clip, fps]);

  // Don't render if off-screen
  if (left + width < 0) return null;

  return (
    <div
      ref={clipRef}
      data-clip-id={clip.id}
      className={`
        absolute top-1 bottom-1 flex items-center overflow-hidden rounded-sm border
        cursor-grab active:cursor-grabbing select-none transition-shadow
        ${colorClass}
        ${isSelected ? 'ring-2 ring-accent ring-offset-1 ring-offset-surface-0 shadow-lg' : ''}
        ${isHovered && !isSelected ? 'brightness-110 shadow-md' : ''}
      `}
      style={{
        left: `${left}px`,
        width: `${Math.max(width, 4)}px`, // minimum 4px visible
      }}
      data-offline={isOffline || undefined}
      onMouseDown={handleMouseDown}
      onClick={handleClick}
      onContextMenu={canSaveAudio ? handleContextMenu : undefined}
      onMouseEnter={() => setHoveredClip(clip.id)}
      onMouseLeave={() => setHoveredClip(null)}
    >
      {/* Left trim handle — hidden on narrow clips so the body stays a move
          surface (#488) */}
      {showsTrimHandles(width) && (
        <div
          className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize bg-white/20 opacity-0 hover:opacity-100 transition-opacity"
          title="Trim start (Shift ripple, Alt this half only)"
        />
      )}

      {/* Fade-in ramp */}
      {fadeInPx > 0 && (
        <div
          className="absolute left-0 top-0 bottom-0 pointer-events-none"
          style={{
            width: `${fadeInPx}px`,
            background: 'linear-gradient(to right, rgba(0,0,0,0.65), transparent)',
          }}
        />
      )}

      {/* Fade-out ramp */}
      {fadeOutPx > 0 && (
        <div
          className="absolute right-0 top-0 bottom-0 pointer-events-none"
          style={{
            width: `${fadeOutPx}px`,
            background: 'linear-gradient(to left, rgba(0,0,0,0.65), transparent)',
          }}
        />
      )}

      {/* Offline state: the source file is gone; relink from the media panel */}
      {isOffline && (
        <div
          className="absolute inset-0 z-10 flex items-center justify-center bg-black/55 pointer-events-none"
          style={{
            backgroundImage:
              'repeating-linear-gradient(45deg, rgba(239,68,68,0.35) 0 6px, transparent 6px 12px)',
          }}
          data-offline-overlay
        >
          {width > 60 && (
            <span className="rounded-sm bg-red-950/80 px-1 text-[9px] font-medium text-red-200">
              Offline
            </span>
          )}
        </div>
      )}

      {/* Filmstrip thumbnails — video clips (R1 lane states) */}
      {stripSlots && stripSlots.length > 0 && (
        <div className="absolute inset-0 z-0 overflow-hidden pointer-events-none">
          {stripSlots.map((slot) => (
            <img
              key={slot.index}
              src={`file://${slot.src}`}
              alt=""
              draggable={false}
              className="absolute top-0 h-full object-cover opacity-90"
              style={{
                left: `${slot.leftRatio * 100}%`,
                width: `${100 / stripSlots.length}%`,
              }}
            />
          ))}
        </div>
      )}

      {/* Audio waveform — full-height bars under the label (R1) */}
      {waveformBars && (
        <div className="absolute inset-0 z-0 flex items-end gap-px overflow-hidden pointer-events-none opacity-50">
          {waveformBars.map((peak: number, i: number) => (
            <div
              key={i}
              className="flex-1 bg-white/70"
              style={{ height: `${Math.max(4, peak * 100)}%`, minWidth: 1 }}
            />
          ))}
        </div>
      )}

      {/* Edit-state badges: speed, pan, color grade visible at a glance */}
      {(clip.speed !== undefined && clip.speed !== 1
        || (clip.pan !== undefined && clip.pan !== 0)
        || clip.brightness !== undefined || clip.contrast !== undefined
        || clip.saturation !== undefined || clip.hueRotation !== undefined) && (
        <div className="absolute bottom-0.5 left-1 z-10 flex items-center gap-0.5 pointer-events-none">
          {clip.speed !== undefined && clip.speed !== 1 && (
            <span className="rounded-sm bg-indigo-900/80 px-0.5 font-mono text-[7px] text-indigo-200" title={`Speed ${clip.speed}×`}>
              {clip.speed}×
            </span>
          )}
          {clip.pan !== undefined && clip.pan !== 0 && (
            <span className="rounded-sm bg-sky-900/80 px-0.5 text-[7px] text-sky-200" title={`Pan ${clip.pan > 0 ? 'R' : 'L'}${Math.abs(clip.pan).toFixed(1)}`}>
              {clip.pan > 0 ? '▶' : '◀'}
            </span>
          )}
          {(clip.brightness || clip.contrast !== undefined && clip.contrast !== 1
            || clip.saturation !== undefined && clip.saturation !== 1
            || clip.hueRotation) && (
            <span className="h-2 w-2 rounded-full border border-white/30" style={{
              background: `conic-gradient(from 0deg, #ef4444, #eab308, #22c55e, #3b82f6, #ef4444)`,
              opacity: 0.8,
            }} title="Color graded" />
          )}
        </div>
      )}

      {/* Clip content */}
      <div className="flex-1 min-w-0 px-1.5 py-0.5">
        {clip.type === 'title' && editingTitle !== null ? (
          <input
            ref={titleInputRef}
            value={editingTitle}
            onChange={(event) => setEditingTitle(event.target.value)}
            onBlur={commitTitle}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitTitle();
              if (event.key === 'Escape') setEditingTitle(null);
            }}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            className="w-full rounded-sm border border-accent/60 bg-surface-0 px-1 text-2xs text-text-primary outline-none"
            aria-label="Title text"
          />
        ) : (
          <>
            {width > 40 && (
              <span
                className="block truncate text-2xs font-medium text-white/90"
                onDoubleClick={
                  clip.type === 'title'
                    ? (event) => {
                        event.stopPropagation();
                        setEditingTitle(clip.label ?? clip.text ?? 'Title');
                      }
                    : undefined
                }
              >
                {clip.type === 'title' ? (clip.text || clip.assetId) : (clip.label || clip.assetId)}
              </span>
            )}
            {width > 80 && (
              <span className="block truncate text-2xs text-white/50">
                {clip.durationFrames}f
              </span>
            )}
          </>
        )}
      </div>

      {/* Right trim handle */}
      {showsTrimHandles(width) && (
        <div
          className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize bg-white/20 opacity-0 hover:opacity-100 transition-opacity"
          title="Trim end (Shift ripple, Alt this half only)"
        />
      )}

      {/* Context menu: Save as audio bakes this clip's trimmed source window
          into a standalone library asset (#562); Detach/Link expose the #462
          link management to the pointer. Fixed-positioned so the clip's
          overflow-hidden body cannot clip it. */}
      {menuPos && (
        <>
          {/* Click-away layer so the menu closes without a global listener. */}
          <div className="fixed inset-0 z-20" onClick={() => setMenuPos(null)} />
          <div
            role="menu"
            className="fixed z-30 min-w-32 rounded border border-white/15 bg-surface-2 py-0.5 shadow-lg"
            style={{ left: menuPos.x, top: menuPos.y }}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              role="menuitem"
              onClick={() => {
                setMenuPos(null);
                duplicateSelected();
              }}
              className="block w-full px-2 py-1 text-left text-[10px] text-text-secondary hover:bg-white/10"
            >
              Duplicate
            </button>
            {canSaveAudio && (
              <button
                role="menuitem"
                onClick={handleSaveAudio}
                className="block w-full px-2 py-1 text-left text-[10px] text-text-secondary hover:bg-white/10"
              >
                Save as audio
              </button>
            )}
            {canDetach && (
              <button
                role="menuitem"
                onClick={handleDetachAudio}
                className="block w-full px-2 py-1 text-left text-[10px] text-text-secondary hover:bg-white/10"
              >
                Detach audio (unlink)
              </button>
            )}
            {canRelink && (
              <button
                role="menuitem"
                onClick={handleLinkSelected}
                className="block w-full px-2 py-1 text-left text-[10px] text-text-secondary hover:bg-white/10"
              >
                Link selected clips
              </button>
            )}
            {(clip.type === 'video' || clip.type === 'image') && (
              <>
                <div className="my-0.5 h-px bg-white/10" />
                <div className="px-2 py-0.5 text-[8px] font-semibold uppercase tracking-wide text-text-muted">
                  Speed
                </div>
                {[0.5, 1, 2].map((rate) => (
                  <button
                    key={rate}
                    role="menuitem"
                    onClick={() => {
                      setMenuPos(null);
                      setClipSpeed(clip.id, rate);
                    }}
                    className={`block w-full px-2 py-1 text-left text-[10px] hover:bg-white/10 ${
                      (clip.speed ?? 1) === rate ? 'text-accent' : 'text-text-secondary'
                    }`}
                  >
                    {rate}× speed{rate === 1 ? ' (normal)' : ''}
                  </button>
                ))}
              </>
            )}
            <button
              role="menuitem"
              onClick={handleCopySettings}
              className="block w-full px-2 py-1 text-left text-[10px] text-text-secondary hover:bg-white/10"
            >
              Copy settings
            </button>
            {snapshotMatches && (
              <>
                <button
                  role="menuitem"
                  onClick={() => pasteWith()}
                  className="block w-full px-2 py-1 text-left text-[10px] text-text-primary hover:bg-white/10"
                >
                  Paste settings
                </button>
                {clip.type === 'audio' ? (
                  <>
                    <button
                      role="menuitem"
                      onClick={() => pasteWith(['volume'])}
                      className="block w-full px-2 py-1 text-left text-[10px] text-text-secondary hover:bg-white/10"
                    >
                      Paste volume only
                    </button>
                    <div className="my-0.5 h-px bg-white/10" />
                    <div className="px-2 py-0.5 text-[8px] font-semibold uppercase tracking-wide text-text-muted">
                      Pan
                    </div>
                    {[[-1, 'Left'], [0, 'Center'], [1, 'Right']].map(([v, label]) => (
                      <button
                        key={label}
                        role="menuitem"
                        onClick={() => {
                          setMenuPos(null);
                          setClipPan(clip.id, v as number);
                        }}
                        className={`block w-full px-2 py-1 text-left text-[10px] hover:bg-white/10 ${
                          (clip.pan ?? 0) === v ? 'text-accent' : 'text-text-secondary'
                        }`}
                      >
                        Pan {label}
                      </button>
                    ))}
                    <div className="my-0.5 h-px bg-white/10" />
                    <button
                      role="menuitem"
                      disabled={normalizing}
                      onClick={handleNormalize}
                      className="block w-full px-2 py-1 text-left text-[10px] text-text-secondary hover:bg-white/10 disabled:text-text-muted"
                    >
                      {normalizing ? 'Normalizing…' : 'Normalize volume'}
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      role="menuitem"
                      onClick={() => pasteWith(['transform'])}
                      className="block w-full px-2 py-1 text-left text-[10px] text-text-secondary hover:bg-white/10"
                    >
                      Paste position &amp; scale
                    </button>
                    <button
                      role="menuitem"
                      onClick={() => pasteWith(['opacity'])}
                      className="block w-full px-2 py-1 text-left text-[10px] text-text-secondary hover:bg-white/10"
                    >
                      Paste opacity only
                    </button>
                    <button
                      role="menuitem"
                      onClick={() => pasteWith(['blendMode'])}
                      className="block w-full px-2 py-1 text-left text-[10px] text-text-secondary hover:bg-white/10"
                    >
                      Paste blend mode only
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
