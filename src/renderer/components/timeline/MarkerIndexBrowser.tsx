/**
 * MarkerIndexBrowser — review list for timeline markers (upstream PR #552's
 * MarkerBrowser, first slice without thumbnails).
 *
 * Sorted by start frame, filterable by search text (name + comment) and by
 * review status. Clicking a row selects the marker and seeks the playhead to
 * its start, matching upstream's `select(seek: true)`; the row's Edit button
 * reopens the same popover the ruler uses so there is one editor path, not two.
 */

import React, { useMemo, useState } from 'react';
import { Search, Flag } from 'lucide-react';
import type { MarkerStatus } from '../../../shared/editor/markers';
import { useTimelineStore } from '../../store/timeline';
import { frameToTimecode } from '../../../shared/utils/time';

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
  const selectMarker = useTimelineStore((s) => s.selectMarker);
  const setPlayhead = useTimelineStore((s) => s.setPlayhead);
  const deleteSelectedMarkers = useTimelineStore((s) => s.deleteSelectedMarkers);
  const selectedMarkerIds = useTimelineStore((s) => s.selectedMarkerIds);

  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<MarkerStatus | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editStatus, setEditStatus] = useState<MarkerStatus>('open');
  const updateMarker = useTimelineStore((s) => s.updateMarker);

  const filtered = useMemo(() => sortedMarkers(markers, query, statusFilter), [markers, query, statusFilter]);

  const jump = (marker: (typeof markers)[number]) => {
    selectMarker(marker.id);
    setPlayhead(marker.startFrame);
  };

  const startEdit = (marker: (typeof markers)[number]) => {
    setEditingId(marker.id);
    setEditStatus(marker.status);
  };

  const commitStatus = () => {
    if (!editingId) return;
    updateMarker(editingId, { status: editStatus });
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
            return (
              <div
                key={marker.id}
                data-marker-row={marker.id}
                data-selected={selected}
                className={`flex items-center gap-2 border-b border-white/[0.06] px-2 py-1.5 transition ${selected ? 'bg-accent/15' : 'hover:bg-white/[0.04]'}`}
              >
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
                  <>
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
                    <button
                      type="button"
                      onClick={commitStatus}
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
                  </>
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
