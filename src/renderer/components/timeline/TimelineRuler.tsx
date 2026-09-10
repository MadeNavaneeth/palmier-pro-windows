/**
 * TimelineRuler — frame/timecode ruler at the top of the timeline.
 * Shows tick marks and time labels, click to position playhead.
 *
 * Also renders timeline markers (upstream PRs #542 / #560): point markers as
 * pennant flags, range markers as bands. Click selects, drag moves (one undo
 * step per drag), Alt-drag stretches the duration (upstream's Option-drag),
 * double-click opens the marker editor popover. Marker frames feed the snap
 * engine through the store's getSnapPoints.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTimelineStore } from '../../store/timeline';
import { frameToTimecode } from '../../../shared/utils/time';
import { MAX_FRAME } from '../../../shared/utils/safe-number';
import { MarkerEditorPopover } from './MarkerEditorPopover';

interface TimelineRulerProps {
  width: number;
}

interface MarkerDragState {
  id: string;
  startX: number;
  origStart: number;
  origDuration: number;
  deltaFrames: number;
  previewDuration: number;
  /** Alt-drag stretches duration (upstream Option-drag); plain drag moves. */
  adjustsDuration: boolean;
  /** Client x of the marker's start edge, so the stretch end tracks the pointer. */
  originClientX: number;
}

export function TimelineRuler({ width }: TimelineRulerProps) {
  const viewport = useTimelineStore((s) => s.viewport);
  const fps = useTimelineStore((s) => s.getProjectFps());
  const setPlayhead = useTimelineStore((s) => s.setPlayhead);
  const startDrag = useTimelineStore((s) => s.startDrag);
  const inFrame = useTimelineStore((s) => s.project.timeline.inFrame);
  const outFrame = useTimelineStore((s) => s.project.timeline.outFrame);
  const rangeStart = inFrame !== undefined && outFrame !== undefined
    ? Math.min(inFrame, outFrame)
    : undefined;
  const rangeEnd = inFrame !== undefined && outFrame !== undefined
    ? Math.max(inFrame, outFrame)
    : undefined;
  const markers = useTimelineStore((s) => s.project.timeline.markers);
  const selectedMarkerIds = useTimelineStore((s) => s.selectedMarkerIds);
  const selectMarker = useTimelineStore((s) => s.selectMarker);
  const updateMarker = useTimelineStore((s) => s.updateMarker);

  const [drag, setDrag] = useState<MarkerDragState | null>(null);
  const [editorMarkerId, setEditorMarkerId] = useState<string | null>(null);

  const xOf = useCallback(
    (frame: number) => (frame - viewport.scrollFrame) * viewport.pixelsPerFrame,
    [viewport.scrollFrame, viewport.pixelsPerFrame],
  );

  // ─── Marker drag: preview locally, commit once on mouse-up ────────────────
  useEffect(() => {
    if (!drag) return;
    const onMove = (event: MouseEvent) => {
      if (drag.adjustsDuration) {
        // Upstream tracks the absolute pointer frame, not the grab offset:
        // the stretch end follows the cursor, clamped at the marker's start.
        const pointerFrame = drag.origStart
          + Math.round((event.clientX - drag.originClientX) / viewport.pixelsPerFrame);
        const previewDuration = Math.min(
          Math.max(0, pointerFrame - drag.origStart),
          Math.max(0, MAX_FRAME - drag.origStart),
        );
        setDrag((current) => (current ? { ...current, previewDuration } : current));
        return;
      }
      const raw = Math.round((event.clientX - drag.startX) / viewport.pixelsPerFrame);
      const clamped = Math.max(-drag.origStart, raw);
      setDrag((current) => (current ? { ...current, deltaFrames: clamped } : current));
    };
    const onUp = () => {
      if (drag.adjustsDuration) {
        if (drag.previewDuration !== drag.origDuration) {
          updateMarker(drag.id, { durationFrames: drag.previewDuration });
        }
      } else if (drag.deltaFrames !== 0) {
        updateMarker(drag.id, { startFrame: Math.max(0, drag.origStart + drag.deltaFrames) });
      }
      setDrag(null);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [drag, viewport.pixelsPerFrame, updateMarker]);

  const beginMarkerDrag = useCallback(
    (event: React.MouseEvent, marker: { id: string; startFrame: number; durationFrames: number }) => {
      event.stopPropagation();
      selectMarker(marker.id, event.shiftKey);
      setEditorMarkerId(null);
      const rect = event.currentTarget.getBoundingClientRect();
      setDrag({
        id: marker.id,
        startX: event.clientX,
        origStart: marker.startFrame,
        origDuration: marker.durationFrames,
        deltaFrames: 0,
        previewDuration: marker.durationFrames,
        adjustsDuration: event.altKey,
        originClientX: rect.left + (marker.startFrame - viewport.scrollFrame) * viewport.pixelsPerFrame,
      });
    },
    [selectMarker, viewport.scrollFrame, viewport.pixelsPerFrame],
  );

  const openEditor = useCallback((event: React.MouseEvent, id: string) => {
    event.stopPropagation();
    selectMarker(id, false);
    setEditorMarkerId(id);
  }, [selectMarker]);

  // The edited marker vanished (deleted via keyboard, selection cleared).
  useEffect(() => {
    if (editorMarkerId && (!selectedMarkerIds.has(editorMarkerId) || !markers?.some((m) => m.id === editorMarkerId))) {
      setEditorMarkerId(null);
    }
  }, [editorMarkerId, selectedMarkerIds, markers]);

  // ─── Ticks ─────────────────────────────────────────────────────────────────

  const { majorInterval, minorInterval } = useMemo(() => {
    const pxPerFrame = viewport.pixelsPerFrame;
    // We want major ticks roughly every 80-150px apart
    const targetMajorPx = 100;
    const framesPerTarget = targetMajorPx / pxPerFrame;

    // Snap to nice frame intervals
    const niceIntervals = [1, 5, 10, 15, 30, 60, 150, 300, 600, 900, 1800];
    let major = niceIntervals[0];
    for (const interval of niceIntervals) {
      major = interval;
      if (interval >= framesPerTarget) break;
    }

    const minor = major <= 30 ? Math.max(1, major / 5) : major / 5;
    return { majorInterval: major, minorInterval: minor };
  }, [viewport.pixelsPerFrame]);

  const ticks = useMemo(() => {
    const result: Array<{ frame: number; x: number; isMajor: boolean; label?: string }> = [];
    const startFrame = Math.floor(viewport.scrollFrame / minorInterval) * minorInterval;
    const endFrame = viewport.scrollFrame + Math.ceil(width / viewport.pixelsPerFrame);

    for (let frame = startFrame; frame <= endFrame; frame += minorInterval) {
      const x = (frame - viewport.scrollFrame) * viewport.pixelsPerFrame;
      if (x < -10 || x > width + 10) continue;

      const isMajor = frame % majorInterval === 0;
      const label = isMajor ? frameToTimecode(frame, fps).slice(0, 8) : undefined; // HH:MM:SS

      result.push({ frame, x, isMajor, label });
    }
    return result;
  }, [viewport.scrollFrame, viewport.pixelsPerFrame, width, majorInterval, minorInterval, fps]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const localX = e.clientX - rect.left;
      const frame = Math.round(localX / viewport.pixelsPerFrame) + viewport.scrollFrame;
      setPlayhead(Math.max(0, frame));
      startDrag('playhead', null, e.clientX, frame);
    },
    [viewport.pixelsPerFrame, viewport.scrollFrame, setPlayhead, startDrag],
  );

  const visibleMarkers = useMemo(() => {
    if (!markers || markers.length === 0) return [];
    return markers.flatMap((marker) => {
      const isDragging = drag?.id === marker.id;
      const start = isDragging && !drag!.adjustsDuration
        ? Math.max(0, marker.startFrame + drag!.deltaFrames)
        : marker.startFrame;
      const duration = isDragging && drag!.adjustsDuration ? drag!.previewDuration : marker.durationFrames;
      const end = start + duration;
      const x = xOf(start);
      const endX = xOf(end);
      if (endX < -20 || x > width + 20) return [];
      return [{ marker, x, endX, selected: selectedMarkerIds.has(marker.id), isDragging }];
    });
  }, [markers, drag, xOf, width, selectedMarkerIds]);

  const [hoverTimecode, setHoverTimecode] = useState<string | null>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);

  const editorMarker = useMemo(() => {
    if (!editorMarkerId || !selectedMarkerIds.has(editorMarkerId)) return undefined;
    return markers?.find((m) => m.id === editorMarkerId);
  }, [editorMarkerId, selectedMarkerIds, markers]);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const frame = Math.max(0, Math.round((e.clientX - rect.left) / viewport.pixelsPerFrame) + viewport.scrollFrame);
      setHoverTimecode(frameToTimecode(frame, fps));
      setHoverX(e.clientX - rect.left);
    },
    [viewport.pixelsPerFrame, viewport.scrollFrame, fps],
  );

  return (
    // Outer wrapper owns popover positioning: the bar itself stays
    // overflow-hidden (ruler content clips like the lanes do) while the
    // editor popover overlays the lanes below without disturbing layout.
    <div className="relative">
      <div
        className="relative h-6 border-b border-surface-3 bg-surface-2 cursor-pointer select-none overflow-hidden"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => { setHoverTimecode(null); setHoverX(null); }}
      >
      <svg width={width} height={24} className="absolute inset-0">
        {rangeStart !== undefined && rangeEnd !== undefined && rangeEnd > rangeStart && (
          <rect
            x={(rangeStart - viewport.scrollFrame) * viewport.pixelsPerFrame}
            y={0}
            width={(rangeEnd - rangeStart) * viewport.pixelsPerFrame}
            height={24}
            fill="rgba(252, 211, 77, 0.16)"
            stroke="rgba(252, 211, 77, 0.75)"
            strokeWidth={1}
            data-marked-range
          />
        )}
        {inFrame !== undefined && (
          <line
            x1={(inFrame - viewport.scrollFrame) * viewport.pixelsPerFrame}
            y1={0}
            x2={(inFrame - viewport.scrollFrame) * viewport.pixelsPerFrame}
            y2={24}
            stroke="rgba(252, 211, 77, 0.95)"
            strokeWidth={2}
            data-in-mark
          />
        )}
        {outFrame !== undefined && (
          <line
            x1={(outFrame - viewport.scrollFrame) * viewport.pixelsPerFrame}
            y1={0}
            x2={(outFrame - viewport.scrollFrame) * viewport.pixelsPerFrame}
            y2={24}
            stroke="rgba(251, 146, 60, 0.95)"
            strokeWidth={2}
            data-out-mark
          />
        )}
        {ticks.map((tick, i) => (
          <g key={i}>
            <line
              x1={tick.x}
              y1={tick.isMajor ? 8 : 16}
              x2={tick.x}
              y2={24}
              stroke={tick.isMajor ? 'var(--color-text-muted)' : 'var(--color-surface-4)'}
              strokeWidth={tick.isMajor ? 1 : 0.5}
            />
            {tick.label && (
              <text
                x={tick.x + 3}
                y={7}
                fontSize={9}
                fill="var(--color-text-muted)"
                fontFamily="var(--font-mono)"
              >
                {tick.label}
              </text>
            )}
          </g>
        ))}

        {/* Timeline markers (#542): ranges as bands, points as pennants. */}
        {visibleMarkers.map(({ marker, x, endX, selected }) => {
          const statusOpacity = marker.status === 'resolved' ? 0.35 : marker.status === 'review' ? 0.85 : 1;
          const bandOpacity = selected ? 0.45 : 0.22;
          return (
          <g key={marker.id} data-marker-id={marker.id} data-selected={selected} data-status={marker.status} style={{ opacity: statusOpacity }}>
            {marker.durationFrames > 0 && (
              <>
                <rect
                  x={x}
                  y={0}
                  width={Math.max(1, endX - x)}
                  height={24}
                  fill={marker.color}
                  fillOpacity={bandOpacity}
                  stroke={selected ? '#ffffff' : 'none'}
                  strokeWidth={1}
                />
                <line x1={x} y1={0} x2={x} y2={24} stroke={marker.color} strokeWidth={2} />
                <line x1={endX} y1={0} x2={endX} y2={24} stroke={marker.color} strokeWidth={2} />
              </>
            )}
            {marker.durationFrames === 0 && (
              <>
                <line
                  x1={x}
                  y1={6}
                  x2={x}
                  y2={24}
                  stroke={marker.color}
                  strokeWidth={selected ? 2.5 : 1.5}
                />
                <polygon
                  points={`${x - 1},1 ${x + 10},1 ${x + 10},7 ${x - 1},7`}
                  fill={marker.color}
                  stroke={selected ? '#ffffff' : 'rgba(0,0,0,0.35)'}
                  strokeWidth={selected ? 1 : 0.5}
                />
              </>
            )}
            {/* Wide invisible hit area so a 1px pole is clickable. */}
            <rect
              x={(marker.durationFrames > 0 ? x : x - 5)}
              y={0}
              width={Math.max(10, marker.durationFrames > 0 ? endX - x : 10)}
              height={24}
              fill="transparent"
              className="cursor-ew-resize"
              onMouseDown={(event) => beginMarkerDrag(event, marker)}
              onDoubleClick={(event) => openEditor(event, marker.id)}
            >
              <title>Drag to move · Alt-drag to stretch duration{(marker.status !== 'open' ? ` · ${marker.status}` : '') + (marker.comment ? ` — ${marker.comment.slice(0, 80)}` : '')}</title>
            </rect>
          </g>
        );
        })}
      </svg>

      {/* Hover timecode badge */}
      {hoverTimecode && hoverX !== null && (
        <div
          className="pointer-events-none absolute top-0 z-10 rounded-sm bg-surface-0/90 px-1 py-px font-mono text-[8px] text-text-secondary"
          style={{ left: Math.min(hoverX + 4, width - 60) }}
        >
          {hoverTimecode}
        </div>
      )}
      </div>

      {editorMarker && (
        <MarkerEditorPopover
          key={editorMarker.id}
          markerId={editorMarker.id}
          x={xOf(editorMarker.startFrame)}
          width={width}
          onClose={() => setEditorMarkerId(null)}
        />
      )}
    </div>
  );
}
