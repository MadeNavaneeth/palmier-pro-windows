/**
 * TimelineTrack — a single track lane that renders its clips.
 * Handles click-to-position-playhead, playhead scrub, and drop-to-add from the
 * media bin (drag a compatible asset to insert a clip at the drop position).
 */

import React, { useCallback, useState } from 'react';
import type { Track, Clip } from '../../../shared/types/project';
import { useTimelineStore } from '../../store/timeline';
import { TimelineClip } from './TimelineClip';
import { ASSET_DND_MIME, getDraggingAsset, isAssetCompatibleWithTrack } from '../../lib/dnd';
import { useProjectStore } from '../../store/project';

interface TimelineTrackProps {
  track: Track;
  clips: Clip[];
}

export function TimelineTrack({ track, clips }: TimelineTrackProps) {
  const viewport = useTimelineStore((s) => s.viewport);
  const setPlayhead = useTimelineStore((s) => s.setPlayhead);
  const deselectAll = useTimelineStore((s) => s.deselectAll);
  const startDrag = useTimelineStore((s) => s.startDrag);
  const addClip = useTimelineStore((s) => s.addClip);
  const snapFrame = useTimelineStore((s) => s.snapFrame);

  // Frame where a dragged asset would land (null when not dragging over).
  const [dropFrame, setDropFrame] = useState<number | null>(null);

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
      const rect = e.currentTarget.getBoundingClientRect();
      startDrag('playhead', null, e.clientX, frameFromClientX(e.clientX, rect));
    },
    [frameFromClientX, startDrag],
  );

  // ─── Drop-to-add from the media bin ─────────────────────────────────────────

  const handleDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      const asset = getDraggingAsset();
      if (track.locked || !asset || !isAssetCompatibleWithTrack(asset.type, track.type)) {
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

  const handleDragLeave = useCallback(() => setDropFrame(null), []);

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDropFrame(null);
      const dragged = getDraggingAsset();
      const assetId = e.dataTransfer.getData(ASSET_DND_MIME) || dragged?.id;
      const assetType = dragged?.type;
      if (!assetId || track.locked) return;
      if (assetType && !isAssetCompatibleWithTrack(assetType, track.type)) return;

      const rect = e.currentTarget.getBoundingClientRect();
      const frame = snapFrame(frameFromClientX(e.clientX, rect));
      addClip(assetId, track.id, frame);
      useProjectStore.getState().markDirty();
    },
    [track.id, track.locked, track.type, frameFromClientX, snapFrame, addClip],
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
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      data-track-id={track.id}
    >
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
