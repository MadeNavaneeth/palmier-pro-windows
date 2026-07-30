import React from 'react';
import {
  Eye,
  EyeOff,
  Link2,
  LockKeyhole,
  LockKeyholeOpen,
  Unlink2,
  Volume2,
  VolumeX,
} from 'lucide-react';
import type { Track } from '../../../shared/types/project';
import { useTimelineStore } from '../../store/timeline';

interface TrackHeaderProps {
  track: Track;
}

export function TrackHeader({ track }: TrackHeaderProps) {
  const isAudio = track.type === 'audio';
  const tint = isAudio ? '#2e7765' : '#1d5878';
  const setTrackLocked = useTimelineStore((state) => state.setTrackLocked);
  const setTrackVisible = useTimelineStore((state) => state.setTrackVisible);
  const setTrackSyncLocked = useTimelineStore((state) => state.setTrackSyncLocked);
  const syncLocked = track.syncLocked !== false;
  const controlClass =
    'flex size-4 shrink-0 items-center justify-center text-text-muted transition hover:bg-white/[0.08] hover:text-text-primary';

  return (
    <div className="relative flex h-12 items-center gap-0.5 border-b border-white/10 px-1.5">
      <span
        className="absolute inset-y-1 left-0 w-0.5 rounded-r"
        style={{ backgroundColor: tint }}
      />
      <span className="min-w-0 flex-1 truncate text-[10px] font-medium text-text-secondary">
        {track.name}
      </span>
      <button
        type="button"
        className={controlClass}
        onClick={() => setTrackSyncLocked(track.id, !syncLocked)}
        title={syncLocked ? 'Disable sync lock' : 'Enable sync lock'}
        aria-label={syncLocked ? 'Disable sync lock' : 'Enable sync lock'}
      >
        {syncLocked ? <Link2 size={11} /> : <Unlink2 size={11} />}
      </button>
      <button
        type="button"
        className={controlClass}
        onClick={() => setTrackLocked(track.id, !track.locked)}
        title={track.locked ? 'Unlock track' : 'Lock track'}
        aria-label={track.locked ? 'Unlock track' : 'Lock track'}
      >
        {track.locked ? <LockKeyhole size={11} /> : <LockKeyholeOpen size={11} />}
      </button>
      <button
        type="button"
        className={controlClass}
        onClick={() => setTrackVisible(track.id, !track.visible)}
        title={
          isAudio
            ? track.visible ? 'Mute track' : 'Unmute track'
            : track.visible ? 'Hide track' : 'Show track'
        }
        aria-label={
          isAudio
            ? track.visible ? 'Mute track' : 'Unmute track'
            : track.visible ? 'Hide track' : 'Show track'
        }
      >
        {isAudio
          ? track.visible ? <Volume2 size={11} /> : <VolumeX size={11} />
          : track.visible ? <Eye size={11} /> : <EyeOff size={11} />}
      </button>
    </div>
  );
}
