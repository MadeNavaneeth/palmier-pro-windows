/**
 * TimelineClip — a single clip rendered on a track lane.
 * Supports: selection, drag-to-move, trim handles (left/right edges).
 */

import React, { useCallback, useRef } from 'react';
import type { Clip } from '../../../shared/types/project';
import { useTimelineStore } from '../../store/timeline';

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

const TRIM_HANDLE_WIDTH = 6; // pixels

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

      if (localX <= TRIM_HANDLE_WIDTH) {
        // Left trim handle
        startDrag('trim-left', clip.id, e.clientX, clip.startFrame);
      } else if (localX >= rect.width - TRIM_HANDLE_WIDTH) {
        // Right trim handle
        startDrag('trim-right', clip.id, e.clientX, clip.startFrame);
      } else {
        // Body — move or select
        if (!isSelected) {
          selectClip(clip.id, e.ctrlKey || e.shiftKey);
        }
        startDrag('move', clip.id, e.clientX, clip.startFrame);
      }
    },
    [clip.id, clip.startFrame, isSelected, selectClip, startDrag],
  );

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      selectClip(clip.id, e.ctrlKey || e.shiftKey);
    },
    [clip.id, selectClip],
  );

  // Don't render if off-screen
  if (left + width < 0) return null;

  return (
    <div
      ref={clipRef}
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
      onMouseEnter={() => setHoveredClip(clip.id)}
      onMouseLeave={() => setHoveredClip(null)}
    >
      {/* Left trim handle */}
      <div
        className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize bg-white/20 opacity-0 hover:opacity-100 transition-opacity"
        title="Trim start"
      />

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
      <div
        className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize bg-white/20 opacity-0 hover:opacity-100 transition-opacity"
        title="Trim end"
      />
    </div>
  );
}
