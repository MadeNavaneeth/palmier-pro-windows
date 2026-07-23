import React from 'react';
import { Eye, EyeOff, LockKeyhole, Volume2, VolumeX } from 'lucide-react';
import type { Track } from '../../../shared/types/project';

interface TrackHeaderProps {
  track: Track;
}

export function TrackHeader({ track }: TrackHeaderProps) {
  const isAudio = track.type === 'audio';
  const tint = isAudio ? '#2e7765' : '#1d5878';

  return (
    <div className="relative flex h-12 items-center gap-1.5 border-b border-white/10 px-2">
      <span
        className="absolute inset-y-1 left-0 w-0.5 rounded-r"
        style={{ backgroundColor: tint }}
      />
      <span className="min-w-0 flex-1 truncate text-[10px] font-medium text-text-secondary">
        {track.name}
      </span>
      {track.locked && <LockKeyhole size={11} className="text-text-muted" />}
      {isAudio
        ? track.visible
          ? <Volume2 size={12} className="text-text-muted" />
          : <VolumeX size={12} className="text-text-muted" />
        : track.visible
          ? <Eye size={12} className="text-text-muted" />
          : <EyeOff size={12} className="text-text-muted" />}
    </div>
  );
}
