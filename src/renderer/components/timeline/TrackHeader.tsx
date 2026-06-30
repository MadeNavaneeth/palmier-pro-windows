/**
 * TrackHeader — the label/controls sidebar for each track.
 * Shows track name, type icon, lock/mute toggles.
 */

import React from 'react';
import type { Track } from '../../../shared/types/project';

interface TrackHeaderProps {
  track: Track;
  onToggleLock?: (trackId: string) => void;
  onToggleVisible?: (trackId: string) => void;
}

export function TrackHeader({ track, onToggleLock, onToggleVisible }: TrackHeaderProps) {
  const typeIcon = track.type === 'video' ? '🎬' : '🔊';

  return (
    <div className="flex h-12 items-center gap-1.5 border-b border-surface-3 px-2 bg-surface-2">
      {/* Type icon */}
      <span className="text-2xs flex-shrink-0">{typeIcon}</span>

      {/* Track name */}
      <span className="flex-1 truncate text-2xs font-medium text-text-secondary">
        {track.name}
      </span>

      {/* Controls */}
      <div className="flex items-center gap-0.5">
        {/* Lock toggle */}
        <button
          onClick={() => onToggleLock?.(track.id)}
          className={`rounded p-0.5 text-2xs transition ${
            track.locked ? 'text-amber-400' : 'text-text-muted hover:text-text-secondary'
          }`}
          title={track.locked ? 'Unlock track' : 'Lock track'}
        >
          {track.locked ? '🔒' : '🔓'}
        </button>

        {/* Visible/Mute toggle */}
        <button
          onClick={() => onToggleVisible?.(track.id)}
          className={`rounded p-0.5 text-2xs transition ${
            !track.visible ? 'text-red-400' : 'text-text-muted hover:text-text-secondary'
          }`}
          title={track.visible ? (track.type === 'audio' ? 'Mute' : 'Hide') : (track.type === 'audio' ? 'Unmute' : 'Show')}
        >
          {track.type === 'audio'
            ? (track.visible ? '🔊' : '🔇')
            : (track.visible ? '👁' : '👁‍🗨')}
        </button>
      </div>
    </div>
  );
}
