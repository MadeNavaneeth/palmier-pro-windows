/**
 * TimelineToolbar — controls above the timeline: timecode display,
 * zoom slider, split/delete buttons, snap toggle.
 */

import React from 'react';
import { useTimelineStore } from '../../store/timeline';
import { frameToTimecode } from '../../../shared/utils/time';

export function TimelineToolbar() {
  const playheadFrame = useTimelineStore((s) => s.project.timeline.playheadFrame);
  const fps = useTimelineStore((s) => s.getProjectFps());
  const viewport = useTimelineStore((s) => s.viewport);
  const zoomIn = useTimelineStore((s) => s.zoomIn);
  const zoomOut = useTimelineStore((s) => s.zoomOut);
  const snapEnabled = useTimelineStore((s) => s.snapEnabled);
  const splitAtPlayhead = useTimelineStore((s) => s.splitAtPlayhead);
  const removeSelectedClips = useTimelineStore((s) => s.removeSelectedClips);
  const selectedClipIds = useTimelineStore((s) => s.selectedClipIds);
  const isPlaying = useTimelineStore((s) => s.isPlaying);
  const playbackRate = useTimelineStore((s) => s.playbackRate);

  const timecode = frameToTimecode(playheadFrame, fps);
  const hasSelection = selectedClipIds.size > 0;

  return (
    <div className="flex items-center justify-between border-b border-surface-3 bg-surface-1 px-3 py-1">
      {/* Left: Timecode + playback state */}
      <div className="flex items-center gap-3">
        <span className="font-mono text-xs text-text-primary tabular-nums">
          {timecode}
        </span>
        {isPlaying && (
          <span className="text-2xs text-accent">
            {playbackRate > 0 ? '▶' : '◀'} {Math.abs(playbackRate) !== 1 ? `${Math.abs(playbackRate)}x` : ''}
          </span>
        )}
      </div>

      {/* Center: Editing tools */}
      <div className="flex items-center gap-1">
        <ToolbarButton
          icon="✂"
          label="Split (C)"
          onClick={splitAtPlayhead}
        />
        <ToolbarButton
          icon="🗑"
          label="Delete (Del)"
          onClick={removeSelectedClips}
          disabled={!hasSelection}
        />
        <div className="mx-1 h-4 w-px bg-surface-3" />
        <ToolbarButton
          icon={snapEnabled ? '🧲' : '⊘'}
          label={`Snap: ${snapEnabled ? 'On' : 'Off'}`}
          onClick={() => useTimelineStore.setState({ snapEnabled: !snapEnabled })}
          active={snapEnabled}
        />
      </div>

      {/* Right: Zoom controls */}
      <div className="flex items-center gap-2">
        <button
          onClick={zoomOut}
          className="rounded p-0.5 text-xs text-text-muted transition hover:bg-surface-3 hover:text-text-primary"
          title="Zoom out (-)"
        >
          −
        </button>
        <span className="text-2xs text-text-muted w-10 text-center tabular-nums">
          {Math.round(viewport.pixelsPerFrame * 10) / 10}px/f
        </span>
        <button
          onClick={zoomIn}
          className="rounded p-0.5 text-xs text-text-muted transition hover:bg-surface-3 hover:text-text-primary"
          title="Zoom in (+)"
        >
          +
        </button>
      </div>
    </div>
  );
}

// ─── Toolbar button ──────────────────────────────────────────────────────────

function ToolbarButton({
  icon,
  label,
  onClick,
  disabled = false,
  active = false,
}: {
  icon: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`
        rounded px-1.5 py-0.5 text-xs transition
        ${disabled ? 'text-text-muted/40 cursor-not-allowed' : 'text-text-muted hover:bg-surface-3 hover:text-text-primary'}
        ${active ? 'bg-surface-3 text-accent' : ''}
      `}
      title={label}
    >
      {icon}
    </button>
  );
}
