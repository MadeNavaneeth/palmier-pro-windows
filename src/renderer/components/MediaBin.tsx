import React from 'react';
import { useProjectStore } from '../store/project';
import { useTimelineStore } from '../store/timeline';
import type { MediaAsset } from '../../shared/types/project';
import { formatDuration } from '../../shared/utils/time';
import { ASSET_DND_MIME, setDraggingAsset } from '../lib/dnd';

export function MediaBin() {
  // Media lives in the timeline controller (single source of truth).
  const project = useTimelineStore((s) => s.project);
  const importAssets = useTimelineStore((s) => s.importAssets);
  const mediaItems = project.media;
  const fps = project.settings.fps;

  async function handleImport() {
    const result = await window.palmier.media.import();
    if (result.success && result.files.length > 0) {
      importAssets(result.files);
      useProjectStore.getState().markDirty();
    }
  }

  return (
    <div className="flex flex-1 flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-surface-3 px-3 py-2">
        <h2 className="text-xs font-medium text-text-secondary uppercase tracking-wide">
          Media
        </h2>
        <button
          onClick={handleImport}
          className="rounded bg-surface-3 px-2 py-1 text-xs text-text-primary transition hover:bg-surface-4"
        >
          + Import
        </button>
      </div>

      {/* Media list */}
      <div className="flex-1 overflow-y-auto p-2">
        {mediaItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="mb-3 text-3xl text-text-muted">🎬</div>
            <p className="text-xs text-text-muted">No media imported yet.</p>
            <p className="mt-1 text-2xs text-text-muted">
              Click "+ Import" or drag files here.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-1.5">
            {mediaItems.map((item) => (
              <MediaCard key={item.id} item={item} fps={fps} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MediaCard({ item, fps }: { item: MediaAsset; fps: number }) {
  const typeIcon = item.type === 'video' ? '🎥' : item.type === 'audio' ? '🎵' : '🖼️';

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(ASSET_DND_MIME, item.id);
        e.dataTransfer.effectAllowed = 'copy';
        setDraggingAsset({ id: item.id, type: item.type });
      }}
      onDragEnd={() => setDraggingAsset(null)}
      title={`Drag onto the timeline to add — ${item.filename}`}
      className="group relative flex cursor-grab flex-col overflow-hidden rounded border border-surface-3 bg-surface-2 transition hover:border-surface-4 active:cursor-grabbing"
    >
      {/* Thumbnail area */}
      <div className="flex h-16 items-center justify-center bg-surface-0 text-lg">
        {item.thumbnailPath ? (
          <img
            src={`file://${item.thumbnailPath}`}
            alt={item.filename}
            className="h-full w-full object-cover"
          />
        ) : (
          <span>{typeIcon}</span>
        )}
      </div>

      {/* Info */}
      <div className="px-1.5 py-1">
        <p className="truncate text-2xs text-text-primary" title={item.filename}>
          {item.filename}
        </p>
        {item.duration > 0 && (
          <p className="text-2xs text-text-muted">
            {formatDuration(item.duration, fps)}
          </p>
        )}
      </div>
    </div>
  );
}
