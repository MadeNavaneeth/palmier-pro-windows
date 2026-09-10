/**
 * MarkerIndexBrowser — review list for timeline markers (upstream PR #552's
 * MarkerBrowser).
 *
 * Sorted by start frame, filterable by search text (name + comment) and by
 * review status. Clicking a row selects the marker and seeks the playhead to
 * its start, matching upstream's `select(seek: true)`; the row's Edit button
 * reopens the same popover the ruler uses so there is one editor path, not two.
 *
 * Rows show a composited thumbnail of the frame the marker sits on, fetched
 * from the preview compositor over IPC and cached per project revision in the
 * main process; the marker's color dot stands in until the pixels arrive.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Flag } from 'lucide-react';
import type { MarkerStatus, TimelineMarker } from '../../../shared/editor/markers';
import { useTimelineStore } from '../../store/timeline';
import { frameToTimecode } from '../../../shared/utils/time';
import { thumbnailSize } from '../../../shared/media/thumbnail';
import { visibleTitleRasters } from '../../engine/title-raster-cache';

function sortedMarkers(
  markers: ReturnType<ReturnType<typeof useTimelineStore.getState>['controller']['getMarkers']>,
  query: string,
  status: MarkerStatus | null,
): typeof markers {
  const needle = query.trim().toLowerCase();
  return markers
    .filter((marker) => (status === null || marker.status === status)
      && (needle.length === 0
        || marker.name.toLowerCase().includes(needle)
        || marker.comment.toLowerCase().includes(needle)))
    .slice()
    .sort((a, b) => a.startFrame - b.startFrame || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function MarkerIndexBrowser() {
  const markers = useTimelineStore((s) => s.controller.getMarkers());
  const fps = useTimelineStore((s) => s.getProjectFps());
  const canvas = useTimelineStore((s) => s.project.settings);
  const selectMarker = useTimelineStore((s) => s.selectMarker);
  const setPlayhead = useTimelineStore((s) => s.setPlayhead);
  const deleteSelectedMarkers = useTimelineStore((s) => s.deleteSelectedMarkers);
  const selectedMarkerIds = useTimelineStore((s) => s.selectedMarkerIds);

  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<MarkerStatus | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editComment, setEditComment] = useState('');
  const [editStatus, setEditStatus] = useState<MarkerStatus>('open');
  const updateMarker = useTimelineStore((s) => s.updateMarker);

  const filtered = useMemo(() => sortedMarkers(markers, query, statusFilter), [markers, query, statusFilter]);

  const jump = (marker: (typeof markers)[number]) => {
    selectMarker(marker.id);
    setPlayhead(marker.startFrame);
  };

  const startEdit = (marker: (typeof markers)[number]) => {
    setEditingId(marker.id);
    setEditName(marker.name);
    setEditComment(marker.comment);
    setEditStatus(marker.status);
  };

  const commitEdit = () => {
    if (!editingId) return;
    const trimmed = editName.trim();
    if (trimmed.length === 0) return;
    updateMarker(editingId, { name: trimmed, comment: editComment, status: editStatus });
    setEditingId(null);
  };

  if (markers.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <Flag size={18} className="text-text-muted" />
        <p className="text-xs text-text-secondary">No markers yet — press M at the playhead to add one.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-1.5 border-b border-white/10 px-2 py-1.5">
        <div className="flex flex-1 items-center gap-1 rounded-sm border border-white/10 bg-surface-0 px-1.5 py-1">
          <Search size={12} className="shrink-0 text-text-muted" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search markers"
            className="min-w-0 flex-1 bg-transparent text-xs text-text-primary outline-none placeholder:text-text-muted"
            aria-label="Search markers"
          />
        </div>
        <select
          value={statusFilter ?? ''}
          onChange={(event) => setStatusFilter((event.target.value || null) as MarkerStatus | null)}
          className="rounded-sm border border-white/10 bg-surface-0 px-1 py-1 text-xs text-text-primary outline-none"
          aria-label="Status filter"
        >
          <option value="">All</option>
          <option value="open">Open</option>
          <option value="review">Review</option>
          <option value="resolved">Resolved</option>
        </select>
      </div>

      {filtered.length === 0 ? (
        <p className="p-4 text-center text-xs text-text-muted">No markers match this filter.</p>
      ) : (
        <div className="flex-1 overflow-auto">
          {filtered.map((marker) => {
            const selected = selectedMarkerIds.has(marker.id);
            const isEditing = editingId === marker.id;
            const thumb = thumbnailSize(canvas.width, canvas.height, 36);
            return (
              <div
                key={marker.id}
                data-marker-row={marker.id}
                data-selected={selected}
                className={`flex items-center gap-2 border-b border-white/[0.06] px-2 py-1.5 transition ${selected ? 'bg-accent/15' : 'hover:bg-white/[0.04]'}`}
              >
                <MarkerThumb marker={marker} thumb={thumb} fps={fps} />
                <button
                  type="button"
                  onClick={() => jump(marker)}
                  className="min-w-0 flex-1 text-left"
                  title={`${marker.name} — ${frameToTimecode(marker.startFrame, fps)}`}
                >
                  <span className="block truncate text-xs font-medium text-text-primary" style={{ color: marker.color }}>
                    {marker.name}
                  </span>
                  <span className="block truncate font-mono text-[10px] text-text-muted">
                    {frameToTimecode(marker.startFrame, fps)}
                    {marker.durationFrames > 0 ? ` +${frameToTimecode(marker.durationFrames, fps)}` : ''}
                    {marker.status !== 'open' ? ` · ${marker.status}` : ''}
                    {marker.comment ? ` — ${marker.comment}` : ''}
                  </span>
                </button>

                {isEditing ? (
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex items-center gap-1">
                      <input
                        value={editName}
                        onChange={(event) => setEditName(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') commitEdit();
                          if (event.key === 'Escape') setEditingId(null);
                        }}
                        placeholder="Marker name"
                        autoFocus
                        className="min-w-0 flex-1 rounded-sm border border-white/10 bg-surface-0 px-1.5 py-0.5 text-xs text-text-primary outline-none focus:border-accent/60"
                        aria-label={`Name for ${marker.name}`}
                      />
                      <select
                        value={editStatus}
                        onChange={(event) => setEditStatus(event.target.value as MarkerStatus)}
                        className="rounded-sm border border-white/10 bg-surface-0 px-1 py-0.5 text-xs text-text-primary outline-none"
                        aria-label={`Status for ${marker.name}`}
                      >
                        <option value="open">Open</option>
                        <option value="review">Review</option>
                        <option value="resolved">Resolved</option>
                      </select>
                    </div>
                    <textarea
                      value={editComment}
                      onChange={(event) => setEditComment(event.target.value)}
                      placeholder="Notes"
                      rows={2}
                      className="w-full resize-none rounded-sm border border-white/10 bg-surface-0 px-1.5 py-1 text-xs text-text-primary outline-none focus:border-accent/60"
                      aria-label={`Notes for ${marker.name}`}
                    />
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={commitEdit}
                        className="rounded bg-accent px-2 py-0.5 text-xs font-medium text-surface-0 hover:bg-accent-hover"
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingId(null)}
                        className="rounded px-1.5 py-0.5 text-xs text-text-muted hover:bg-white/10"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => startEdit(marker)}
                      className="rounded px-1.5 py-0.5 text-xs text-text-muted hover:bg-white/10"
                      title={`Change status for ${marker.name}`}
                    >
                      {marker.status}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        selectMarker(marker.id);
                        deleteSelectedMarkers();
                        if (editingId === marker.id) setEditingId(null);
                      }}
                      className="rounded px-1.5 py-0.5 text-xs text-red-400 hover:bg-red-500/10"
                      title={`Delete ${marker.name}`}
                    >
                      Remove
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface ThumbnailResult {
  success: boolean;
  width?: number;
  height?: number;
  rgba?: Uint8Array | ArrayBuffer;
}

/**
 * One marker's composited frame, drawn into a small canvas. The color-dot
 * plate underneath stays visible until (or if) the pixels arrive, so a row
 * never collapses to an empty box while the compositor works.
 */
function MarkerThumb({
  marker,
  thumb,
  fps,
}: {
  marker: TimelineMarker;
  thumb: { width: number; height: number };
  fps: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loaded, setLoaded] = useState(false);
  // Every project mutation mints a new revision; re-requesting is cheap
  // because main caches thumbnails per project token + frame + size.
  const revision = useTimelineStore((s) => s.project.updatedAt);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    // Titles need the renderer's canvas/font engine, so rasterize them here
    // exactly like the live preview does and hand them to the compositor.
    const titles = visibleTitleRasters(useTimelineStore.getState().project, marker.startFrame);
    void window.palmier.preview
      .thumbnail(marker.startFrame, 36, titles)
      .then((raw: unknown) => {
        if (cancelled) return;
        const result = raw as ThumbnailResult | undefined;
        if (!result?.success || !result.rgba || !result.width || !result.height) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        // Copy into a fresh clamped array so ImageData always gets an
        // ArrayBuffer-backed view (IPC views may be SharedArrayBuffer-backed).
        const bytes = result.rgba instanceof ArrayBuffer
          ? new Uint8ClampedArray(result.rgba)
          : new Uint8ClampedArray(result.rgba as Uint8Array);
        canvas.width = result.width;
        canvas.height = result.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.putImageData(new ImageData(bytes, result.width, result.height), 0, 0);
        setLoaded(true);
      })
      .catch(() => {
        // A failed thumbnail leaves the color plate; never blocks the row.
      });
    return () => {
      cancelled = true;
    };
  }, [marker.startFrame, revision]);

  return (
    <div
      className="relative shrink-0 overflow-hidden rounded-sm border border-white/10 bg-black"
      style={{ width: thumb.width, height: thumb.height }}
      title={`Frame ${frameToTimecode(marker.startFrame, fps)}`}
      data-marker-thumb={marker.id}
    >
      <div
        className="absolute inset-0 flex items-center justify-center"
        style={{ backgroundColor: `${marker.color}18` }}
      >
        <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: marker.color }} />
      </div>
      <canvas
        ref={canvasRef}
        className="relative h-full w-full"
        style={{ opacity: loaded ? 1 : 0 }}
        aria-hidden="true"
      />
    </div>
  );
}
