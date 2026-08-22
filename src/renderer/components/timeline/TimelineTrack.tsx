/**
 * TimelineTrack — a single track lane that renders its clips.
 * Handles click-to-position-playhead, playhead scrub, and drop-to-add from the
 * media bin (drag a compatible asset to insert a clip at the drop position).
 */

import React, { useCallback, useState } from 'react';
import type { Track, Clip } from '../../../shared/types/project';
import { useTimelineStore } from '../../store/timeline';
import { TimelineClip } from './TimelineClip';
import {
  ASSET_DND_MIME,
  getDraggingAsset,
  getDroppedFilePath,
  isAssetCompatibleWithTrack,
} from '../../lib/dnd';
import { useProjectStore } from '../../store/project';

interface TimelineTrackProps {
  track: Track;
  clips: Clip[];
  /**
   * Lane-background drag starts a rubber-band marquee (R1). The parent owns
   * the geometry because the band can span tracks; scrubbing stays on the
   * ruler, and a plain click still seeks via handleTrackClick.
   */
  onLaneMouseDown?: (e: React.MouseEvent<HTMLDivElement>) => void;
}

export function TimelineTrack({ track, clips, onLaneMouseDown }: TimelineTrackProps) {
  const viewport = useTimelineStore((s) => s.viewport);
  const setPlayhead = useTimelineStore((s) => s.setPlayhead);
  const deselectAll = useTimelineStore((s) => s.deselectAll);
  const placeAssets = useTimelineStore((s) => s.placeAssets);
  const importAndPlaceAssets = useTimelineStore((s) => s.importAndPlaceAssets);
  const snapFrame = useTimelineStore((s) => s.snapFrame);
  const selectedGap = useTimelineStore((s) => s.selectedGap);
  const selectGap = useTimelineStore((s) => s.selectGap);
  const inFrame = useTimelineStore((s) => s.project.timeline.inFrame);
  const outFrame = useTimelineStore((s) => s.project.timeline.outFrame);

  // Frame where a dragged asset would land (null when not dragging over).
  const [dropFrame, setDropFrame] = useState<number | null>(null);
  const [dropError, setDropError] = useState('');

  const frameFromClientX = useCallback(
    (clientX: number, rect: DOMRect) => {
      const localX = clientX - rect.left;
      return Math.max(0, Math.round(localX / viewport.pixelsPerFrame) + viewport.scrollFrame);
    },
    [viewport.pixelsPerFrame, viewport.scrollFrame],
  );

  const handleTrackClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      if (target !== e.currentTarget) return;
      const rect = e.currentTarget.getBoundingClientRect();
      setPlayhead(frameFromClientX(e.clientX, rect));
      deselectAll();
    },
    [frameFromClientX, setPlayhead, deselectAll],
  );

  const handleTrackMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target !== e.currentTarget) return;
      onLaneMouseDown?.(e);
    },
    [onLaneMouseDown],
  );

  // ─── Drop-to-add from the media bin ─────────────────────────────────────────

  const handleDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      const isFileDrop = e.dataTransfer.types.includes('Files');
      const asset = getDraggingAsset();
      const acceptsLibraryAsset = asset && isAssetCompatibleWithTrack(asset.type, track.type);
      if (track.locked || (!isFileDrop && !acceptsLibraryAsset)) {
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
        return;
      }
      // preventDefault enables the drop; only do it for a valid target.
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      const rect = e.currentTarget.getBoundingClientRect();
      setDropFrame(snapFrame(frameFromClientX(e.clientX, rect)));
    },
    [track.locked, track.type, frameFromClientX, snapFrame],
  );

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setDropFrame(null);
    }
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDropFrame(null);
      setDropError('');

      const rect = e.currentTarget.getBoundingClientRect();
      const frame = snapFrame(frameFromClientX(e.clientX, rect));

      if (e.dataTransfer.types.includes('Files')) {
        const paths = Array.from(e.dataTransfer.files)
          .map((file) => getDroppedFilePath(file, window.palmier.media.getPathForFile))
          .filter((filePath): filePath is string => Boolean(filePath));

        if (paths.length === 0) {
          setDropError('Windows did not provide a readable file path.');
          return;
        }

        const imported = await window.palmier.media.importPaths(paths);
        if (imported.files.length === 0) {
          setDropError(imported.errors?.[0] || 'No supported media files found.');
          return;
        }

        const placed = importAndPlaceAssets(imported.files, track.id, frame);
        if (placed.clipIds.length > 0) {
          useTimelineStore.setState({ selectedClipIds: new Set(placed.clipIds) });
          setPlayhead(frame);
        }
        if (imported.errors?.length) setDropError(imported.errors[0]);
        useProjectStore.getState().markDirty();
        return;
      }

      const dragged = getDraggingAsset();
      const assetId = e.dataTransfer.getData(ASSET_DND_MIME) || dragged?.id;
      const assetType = dragged?.type;
      if (!assetId || track.locked) return;
      if (assetType && !isAssetCompatibleWithTrack(assetType, track.type)) return;

      const clipIds = placeAssets([assetId], track.id, frame);
      if (clipIds.length === 0) return;
      useTimelineStore.setState({ selectedClipIds: new Set(clipIds) });
      setPlayhead(frame);
      useProjectStore.getState().markDirty();
    },
    [
      track.id,
      track.locked,
      track.type,
      frameFromClientX,
      snapFrame,
      placeAssets,
      importAndPlaceAssets,
      setPlayhead,
    ],
  );

  const handleTrackDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target !== e.currentTarget) return;
      const rect = e.currentTarget.getBoundingClientRect();
      selectGap(track.id, frameFromClientX(e.clientX, rect));
    },
    [frameFromClientX, selectGap, track.id],
  );

  const bgColor = track.type === 'video' ? 'bg-surface-0/50' : 'bg-surface-0/30';
  const lockOverlay = track.locked ? 'opacity-50 pointer-events-none' : '';
  const dropX =
    dropFrame !== null ? (dropFrame - viewport.scrollFrame) * viewport.pixelsPerFrame : 0;

  return (
    <div
      className={`relative h-12 border-b border-surface-3 ${bgColor} ${lockOverlay} ${dropFrame !== null ? 'ring-1 ring-inset ring-accent/40' : ''}`}
      onClick={handleTrackClick}
      onMouseDown={handleTrackMouseDown}
      onDoubleClick={handleTrackDoubleClick}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      data-track-id={track.id}
    >
      {inFrame !== undefined && outFrame !== undefined && outFrame > inFrame && (
        <div
          className="absolute inset-y-0 border-x border-amber-300/30 bg-amber-300/[0.06] pointer-events-none"
          style={{
            left: `${(inFrame - viewport.scrollFrame) * viewport.pixelsPerFrame}px`,
            width: `${(outFrame - inFrame) * viewport.pixelsPerFrame}px`,
          }}
        />
      )}
      {selectedGap?.trackId === track.id && (
        <div
          className="absolute inset-y-0 z-10 border-x border-amber-300/70 bg-amber-300/15 pointer-events-none"
          style={{
            left: `${(selectedGap.startFrame - viewport.scrollFrame) * viewport.pixelsPerFrame}px`,
            width: `${(selectedGap.endFrame - selectedGap.startFrame) * viewport.pixelsPerFrame}px`,
          }}
          data-selected-gap
        />
      )}
      {/* Track grid lines (subtle) */}
      <div className="absolute inset-0 pointer-events-none opacity-10">
        <div className="h-full w-full" style={{
          backgroundImage: `repeating-linear-gradient(90deg, transparent, transparent ${viewport.pixelsPerFrame * 30 - 1}px, var(--color-surface-4) ${viewport.pixelsPerFrame * 30 - 1}px, var(--color-surface-4) ${viewport.pixelsPerFrame * 30}px)`,
          backgroundPosition: `${-viewport.scrollFrame * viewport.pixelsPerFrame}px 0`,
        }} />
      </div>

      {/* Clips */}
      {clips.map((clip) => (
        <TimelineClip key={clip.id} clip={clip} />
      ))}

      {/* Drop indicator */}
      {dropFrame !== null && (
        <div
          className="absolute top-0 bottom-0 z-20 w-0.5 bg-accent pointer-events-none"
          style={{ left: `${dropX}px` }}
        />
      )}

      {dropError && (
        <button
          type="button"
          onClick={() => setDropError('')}
          className="absolute bottom-1 right-2 z-30 max-w-72 truncate rounded border border-red-500/40 bg-red-950/90 px-2 py-1 text-[9px] text-red-200"
          title="Dismiss import error"
        >
          {dropError}
        </button>
      )}

      {/* Hidden indicator */}
      {!track.visible && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="text-2xs text-text-muted opacity-50">
            {track.type === 'audio' ? 'Muted' : 'Hidden'}
          </span>
        </div>
      )}
    </div>
  );
}
