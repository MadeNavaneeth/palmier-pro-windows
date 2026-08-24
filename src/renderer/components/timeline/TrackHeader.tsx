import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Eye,
  EyeOff,
  Link2,
  LockKeyhole,
  LockKeyholeOpen,
  Trash2,
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
  const setTrackName = useTimelineStore((state) => state.setTrackName);
  const selectAllClipsOnTrack = useTimelineStore((state) => state.selectAllClipsOnTrack);
  const controller = useTimelineStore((state) => state.controller);
  const clipCount = useTimelineStore(
    (state) => state.getClips().filter((clip) => clip.trackId === track.id).length,
  );
  const syncLocked = track.syncLocked !== false;
  const controlClass =
    'flex size-4 shrink-0 items-center justify-center text-text-muted transition hover:bg-white/[0.08] hover:text-text-primary';

  // Inline rename (#520). Editing state lives here, not in the store: a
  // rename in progress is view state, and tearing it down on any store change
  // would lose a half-typed name.
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const renameRef = useRef<HTMLInputElement>(null);

  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (renaming) {
      renameRef.current?.focus();
      renameRef.current?.select();
    }
  }, [renaming]);

  const commitRename = () => {
    if (renaming) {
      setTrackName(track.id, draft);
      setRenaming(false);
    }
  };

  return (
    <div
      className="relative flex h-12 items-center gap-0.5 border-b border-white/10 px-1.5"
      onContextMenu={(event) => {
        event.preventDefault();
        setMenuOpen(true);
      }}
    >
      <span
        className="absolute inset-y-1 left-0 w-0.5 rounded-r"
        style={{ backgroundColor: tint }}
      />
      {renaming ? (
        <input
          ref={renameRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitRename}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commitRename();
            if (event.key === 'Escape') setRenaming(false);
          }}
          maxLength={200}
          aria-label="Track name"
          className="min-w-0 flex-1 rounded-sm border border-accent/60 bg-surface-0 px-1 py-0.5 text-[10px] text-text-primary outline-none"
        />
      ) : (
        <span
          className="min-w-0 flex-1 cursor-text truncate text-[10px] font-medium text-text-secondary"
          title={`${track.name} - double-click to rename`}
          onDoubleClick={(event) => {
            event.stopPropagation();
            setDraft(track.name);
            setRenaming(true);
          }}
        >
          {track.name}
        </span>
      )}
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

      {menuOpen && (
        <>
          {/* Click-away layer so the menu closes without a global listener. */}
          <div className="fixed inset-0 z-20" onClick={() => setMenuOpen(false)} />
          <div
            role="menu"
            className="absolute left-1 top-7 z-30 min-w-36 rounded border border-white/15 bg-surface-2 py-0.5 shadow-lg"
          >
            <button
              role="menuitem"
              disabled={clipCount === 0}
              onClick={() => {
                setMenuOpen(false);
                selectAllClipsOnTrack(track.id);
              }}
              className="block w-full px-2 py-1 text-left text-[10px] text-text-secondary hover:bg-white/10 disabled:cursor-default disabled:text-text-muted disabled:hover:bg-transparent"
            >
              Select all clips on track
            </button>
            <button
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                setDraft(track.name);
                setRenaming(true);
              }}
              className="block w-full px-2 py-1 text-left text-[10px] text-text-secondary hover:bg-white/10"
            >
              Rename track
            </button>
            {isAudio && clipCount > 0 && (
              <button
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  useTimelineStore.getState().autoCrossfadeAudio(track.id);
                }}
                className="block w-full px-2 py-1 text-left text-[10px] text-text-secondary hover:bg-white/10"
              >
                Auto-crossfade audio
              </button>
            )}
            <MoveUpDownItems track={track} onDone={() => setMenuOpen(false)} />
            {clipCount === 0 && (
              <button
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  try {
                    controller.manageTracks({ remove: [track.id] });
                  } catch {
                    // Last-of-type refusal is non-actionable from the menu.
                  }
                }}
                className="block w-full px-2 py-1 text-left text-[10px] text-red-300 hover:bg-red-500/10"
              >
                Delete track
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function MoveUpDownItems({ track, onDone }: { track: Track; onDone: () => void }) {
  const controller = useTimelineStore((s) => s.controller);
  const allTracks = controller.getTracks();
  const sameType = allTracks.filter((t) => t.type === track.type);
  if (sameType.length <= 1) return null;

  const idx = sameType.findIndex((t) => t.id === track.id);
  const canUp = idx > 0;
  const canDown = idx < sameType.length - 1;
  if (!canUp && !canDown) return null;

  const move = (dir: -1 | 1): void => {
    onDone();
    // Swap with the adjacent same-type track via manageTracks reorder.
    const target = sameType[idx + dir];
    if (!target) return;
    // manageTracks reorder uses absolute array index.
    const absTarget = allTracks.findIndex((t) => t.id === target.id);
    try {
      controller.manageTracks({ reorder: [{ trackId: track.id, to: absTarget }] });
    } catch { /* non-actionable */ }
  };

  return (
    <>
      <button
        role="menuitem"
        disabled={!canUp}
        onClick={() => move(-1)}
        className="block w-full px-2 py-1 text-left text-[10px] text-text-secondary hover:bg-white/10 disabled:text-text-muted disabled:hover:bg-transparent"
      >
        Move up
      </button>
      <button
        role="menuitem"
        disabled={!canDown}
        onClick={() => move(1)}
        className="block w-full px-2 py-1 text-left text-[10px] text-text-secondary hover:bg-white/10 disabled:text-text-muted disabled:hover:bg-transparent"
      >
        Move down
      </button>
    </>
  );
}
