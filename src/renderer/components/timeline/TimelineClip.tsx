/**
 * TimelineClip — a single clip rendered on a track lane.
 * Supports: selection, drag-to-move, trim handles (left/right edges),
 * and a context menu ("Save as audio" bakes the clip's trimmed source
 * window into a standalone library asset, upstream PR #562).
 */

import React, { useCallback, useRef, useState } from 'react';
import type { Clip } from '../../../shared/types/project';
import { useTimelineStore } from '../../store/timeline';
import {
  resolveClipHitZone,
  showsTrimHandles,
} from '../../lib/timeline-clip-hit';
import { clipTrimSeconds } from '../../../shared/media/source-time';
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
  const asset = useTimelineStore((s) => s.project.media.find((m) => m.id === clip.assetId));
  const canSaveAudio =
    (clip.type === 'video' || clip.type === 'audio') && Boolean(asset?.audioCodec);
  // Viewport-fixed coordinates: the clip body is overflow-hidden, which would
  // clip an absolutely-positioned menu on short clips.
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);

  // Position and size
  const left = (clip.startFrame - viewport.scrollFrame) * viewport.pixelsPerFrame;
  const width = clip.durationFrames * viewport.pixelsPerFrame;

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
        // Left trim handle
        startDrag('trim-left', clip.id, e.clientX, clip.startFrame, e.shiftKey);
      } else if (zone === 'trim-right') {
        // Right trim handle
        startDrag('trim-right', clip.id, e.clientX, clip.startFrame, e.shiftKey);
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
          title="Trim start (hold Shift to ripple)"
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

      {/* Clip content */}
      <div className="flex-1 min-w-0 px-1.5 py-0.5">
        {width > 40 && (
          <span className="block truncate text-2xs font-medium text-white/90">
            {clip.label || clip.assetId}
          </span>
        )}
        {width > 80 && (
          <span className="block truncate text-2xs text-white/50">
            {clip.durationFrames}f
          </span>
        )}
      </div>

      {/* Right trim handle */}
      {showsTrimHandles(width) && (
        <div
          className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize bg-white/20 opacity-0 hover:opacity-100 transition-opacity"
          title="Trim end (hold Shift to ripple)"
        />
      )}

      {/* Context menu: Save as audio bakes this clip's trimmed source window
          into a standalone library asset (#562). Fixed-positioned so the
          clip's overflow-hidden body cannot clip it. */}
      {menuPos && canSaveAudio && (
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
              onClick={handleSaveAudio}
              className="block w-full px-2 py-1 text-left text-[10px] text-text-secondary hover:bg-white/10"
            >
              Save as audio
            </button>
          </div>
        </>
      )}
    </div>
  );
}
