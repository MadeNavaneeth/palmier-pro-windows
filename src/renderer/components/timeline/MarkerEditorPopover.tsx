/**
 * MarkerEditorPopover — hand-editing for a timeline marker's full field set
 * (upstream PR #542's MarkerEditorPopover).
 *
 * Name, start, and duration were partially reachable before (inline rename,
 * ruler drag), but color and comment were Agent/MCP-only. The popover edits
 * the whole marker as one draft committed in a single undo step on Done, like
 * upstream's apply(). Deliberate differences: no live preview of each
 * keystroke (a transient preview has no clean undo story here), and time
 * fields accept plain frames as well as HH:MM:SS:FF.
 */

import React, { useState } from 'react';
import { MARKER_DEFAULT_COLOR, type MarkerStatus } from '../../../shared/editor/markers';
import { frameToTimecode } from '../../../shared/utils/time';
import { useTimelineStore } from '../../store/timeline';
import { parseMarkerFrameInput } from './marker-frame-input';

/** Same hues as the clip label picker, so marker and clip tags match. */
const MARKER_COLOR_SWATCHES = [
  { color: MARKER_DEFAULT_COLOR, label: 'Default blue' },
  { color: '#ef4444', label: 'Red' },
  { color: '#f97316', label: 'Orange' },
  { color: '#eab308', label: 'Yellow' },
  { color: '#22c55e', label: 'Green' },
  { color: '#06b6d4', label: 'Cyan' },
  { color: '#3b82f6', label: 'Blue' },
  { color: '#8b5cf6', label: 'Purple' },
  { color: '#ec4899', label: 'Pink' },
  { color: '#78716c', label: 'Gray' },
];

interface MarkerEditorPopoverProps {
  markerId: string;
  /** Marker x in ruler pixels, for anchoring. */
  x: number;
  /** Ruler width in pixels, for clamping. */
  width: number;
  onClose: () => void;
}

export function MarkerEditorPopover({ markerId, x, width, onClose }: MarkerEditorPopoverProps) {
  const marker = useTimelineStore((s) => s.project.timeline.markers?.find((m) => m.id === markerId));
  const fps = useTimelineStore((s) => s.getProjectFps());
  const updateMarker = useTimelineStore((s) => s.updateMarker);
  const deleteSelectedMarkers = useTimelineStore((s) => s.deleteSelectedMarkers);
  const clearMarkerSelection = useTimelineStore((s) => s.clearMarkerSelection);

  const [name, setName] = useState(marker?.name ?? '');
  const [start, setStart] = useState(marker ? frameToTimecode(marker.startFrame, fps) : '');
  const [duration, setDuration] = useState(marker ? frameToTimecode(marker.durationFrames, fps) : '');
  const [comment, setComment] = useState(marker?.comment ?? '');
  const [color, setColor] = useState(marker?.color ?? MARKER_DEFAULT_COLOR);
  const [status, setStatus] = useState<MarkerStatus>(marker?.status ?? 'open');
  const [error, setError] = useState<string | null>(null);

  // The marker vanished underneath (deleted via keyboard while open).
  if (!marker) return null;

  const done = () => {
    const startFrame = parseMarkerFrameInput(start, fps);
    const durationFrames = parseMarkerFrameInput(duration, fps);
    if (startFrame === null || durationFrames === null) {
      setError('Enter frames or HH:MM:SS:FF for start and duration.');
      return;
    }
    const ok = updateMarker(marker.id, { name, startFrame, durationFrames, color, comment, status });
    if (!ok) {
      setError('Check the marker name, position, and duration.');
      return;
    }
    clearMarkerSelection();
    onClose();
  };

  const remove = () => {
    deleteSelectedMarkers();
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-label={`Edit marker ${marker.name}`}
      className="absolute top-7 z-30 w-64 rounded-md border border-white/10 bg-surface-1 p-3 shadow-2xl"
      style={{ left: Math.min(Math.max(0, x - 8), Math.max(0, width - 264)) }}
      onMouseDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <label className="mb-1 block text-2xs uppercase tracking-wide text-text-muted" htmlFor="marker-editor-name">
        Name
      </label>
      <input
        id="marker-editor-name"
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
        className="mb-2 w-full rounded-sm border border-white/10 bg-surface-0 px-1.5 py-1 text-xs text-text-primary outline-none focus:border-accent/70"
      />
      <div className="mb-2 grid grid-cols-2 gap-2">
        <div>
          <label className="mb-1 block text-2xs uppercase tracking-wide text-text-muted" htmlFor="marker-editor-start">
            Start
          </label>
          <input
            id="marker-editor-start"
            value={start}
            onChange={(event) => setStart(event.target.value)}
            className="w-full rounded-sm border border-white/10 bg-surface-0 px-1.5 py-1 font-mono text-xs text-text-primary outline-none focus:border-accent/70"
          />
        </div>
        <div>
          <label className="mb-1 block text-2xs uppercase tracking-wide text-text-muted" htmlFor="marker-editor-duration">
            Duration
          </label>
          <input
            id="marker-editor-duration"
            value={duration}
            onChange={(event) => setDuration(event.target.value)}
            className="w-full rounded-sm border border-white/10 bg-surface-0 px-1.5 py-1 font-mono text-xs text-text-primary outline-none focus:border-accent/70"
          />
        </div>
      </div>
      <label className="mb-1 block text-2xs uppercase tracking-wide text-text-muted" htmlFor="marker-editor-notes">
        Notes
      </label>
      <textarea
        id="marker-editor-notes"
        value={comment}
        onChange={(event) => setComment(event.target.value)}
        rows={3}
        className="mb-2 w-full resize-none rounded-sm border border-white/10 bg-surface-0 px-1.5 py-1 text-xs text-text-primary outline-none focus:border-accent/70"
      />
      <span className="mb-1 block text-2xs uppercase tracking-wide text-text-muted" id="marker-editor-color-label">
        Color
      </span>
      <div className="mb-2 flex flex-wrap gap-1" role="group" aria-labelledby="marker-editor-color-label">
        {MARKER_COLOR_SWATCHES.map(({ color: swatch, label }) => (
          <button
            key={label}
            type="button"
            title={label}
            aria-label={label}
            aria-pressed={color === swatch}
            onClick={() => setColor(swatch)}
            className={`h-5 w-5 rounded-full border-2 transition ${
              color === swatch ? 'scale-110 border-white' : 'border-transparent hover:border-white/40'
            }`}
            style={{ backgroundColor: swatch }}
          />
        ))}
      </div>
      <label className="mb-1 block text-2xs uppercase tracking-wide text-text-muted" htmlFor="marker-editor-status">
        Status
      </label>
      <select
        id="marker-editor-status"
        value={status}
        onChange={(event) => setStatus(event.target.value as MarkerStatus)}
        className="mb-2 w-full rounded-sm border border-white/10 bg-surface-0 px-1.5 py-1 text-xs text-text-primary outline-none focus:border-accent/70"
      >
        <option value="open">Open</option>
        <option value="review">Review</option>
        <option value="resolved">Resolved</option>
      </select>
      {error && (
        <p role="alert" className="mb-2 text-xs text-red-400">
          {error}
        </p>
      )}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={remove}
          className="rounded px-2 py-1 text-xs text-red-400 transition hover:bg-red-500/10"
        >
          Remove marker
        </button>
        <button
          type="button"
          onClick={done}
          className="rounded bg-accent px-3 py-1 text-xs font-medium text-surface-0 transition hover:bg-accent-hover"
        >
          Done
        </button>
      </div>
    </div>
  );
}
