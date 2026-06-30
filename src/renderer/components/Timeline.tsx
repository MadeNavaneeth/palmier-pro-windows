/**
 * Timeline — the main timeline panel assembling ruler, tracks, clips,
 * playhead, snap lines, and toolbar. Uses the new timeline store and
 * drag/keyboard hooks.
 */

import React, { useRef, useCallback, useEffect, useState } from 'react';
import { useTimelineStore } from '../store/timeline';
import { useDragHandler } from '../hooks/useDragHandler';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { TimelineToolbar } from './timeline/TimelineToolbar';
import { TimelineRuler } from './timeline/TimelineRuler';
import { TimelineTrack } from './timeline/TimelineTrack';
import { TrackHeader } from './timeline/TrackHeader';
import { PlayheadIndicator } from './timeline/PlayheadIndicator';
import { SnapLine } from './timeline/SnapLine';

export function Timeline() {
  const tracks = useTimelineStore((s) => s.getTracks());
  const clips = useTimelineStore((s) => s.getClips());
  const addTrack = useTimelineStore((s) => s.addTrack);
  const viewport = useTimelineStore((s) => s.viewport);
  const scrollTo = useTimelineStore((s) => s.scrollTo);

  const tracksContainerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(800);

  // Activate global hooks
  useDragHandler();
  useKeyboardShortcuts();

  // Track container width for ruler
  useEffect(() => {
    const el = tracksContainerRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Horizontal scroll handler
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (e.shiftKey || e.deltaX !== 0) {
        // Horizontal scroll
        const deltaFrames = Math.round((e.deltaX || e.deltaY) / viewport.pixelsPerFrame);
        scrollTo(viewport.scrollFrame + deltaFrames);
        e.preventDefault();
      } else if (e.ctrlKey) {
        // Zoom with ctrl+wheel
        e.preventDefault();
        const zoomFactor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        const newPxPerFrame = Math.max(
          viewport.minPxPerFrame,
          Math.min(viewport.maxPxPerFrame, viewport.pixelsPerFrame * zoomFactor),
        );
        useTimelineStore.setState({
          viewport: { ...viewport, pixelsPerFrame: newPxPerFrame },
        });
      }
    },
    [viewport, scrollTo],
  );

  // Sort tracks: video (higher order on top), audio at bottom
  const sortedTracks = [...tracks].sort((a, b) => b.order - a.order);

  return (
    <section className="flex flex-col border-t border-surface-3 bg-surface-1" style={{ height: '240px' }}>
      {/* Toolbar */}
      <TimelineToolbar />

      {/* Tracks area */}
      <div className="flex flex-1 overflow-hidden" onWheel={handleWheel}>
        {/* Track headers (labels) */}
        <div className="flex w-28 flex-shrink-0 flex-col border-r border-surface-3 bg-surface-2">
          {/* Ruler spacer */}
          <div className="h-6 border-b border-surface-3" />
          {/* Track headers */}
          {sortedTracks.map((track) => (
            <TrackHeader key={track.id} track={track} />
          ))}
          {/* Add track button */}
          <div className="flex items-center gap-1 px-2 py-1">
            <button
              onClick={() => addTrack('video')}
              className="rounded px-1 py-0.5 text-2xs text-text-muted transition hover:bg-surface-3 hover:text-text-primary"
              title="Add video track"
            >
              +V
            </button>
            <button
              onClick={() => addTrack('audio')}
              className="rounded px-1 py-0.5 text-2xs text-text-muted transition hover:bg-surface-3 hover:text-text-primary"
              title="Add audio track"
            >
              +A
            </button>
          </div>
        </div>

        {/* Timeline lanes (scrollable) */}
        <div ref={tracksContainerRef} className="relative flex-1 overflow-hidden">
          {/* Ruler */}
          <TimelineRuler width={containerWidth} />

          {/* Track lanes */}
          <div className="relative">
            {sortedTracks.map((track) => (
              <TimelineTrack
                key={track.id}
                track={track}
                clips={clips.filter((c) => c.trackId === track.id)}
              />
            ))}

            {/* Playhead (spans all tracks) */}
            <PlayheadIndicator />

            {/* Snap line (spans all tracks) */}
            <SnapLine />
          </div>
        </div>
      </div>
    </section>
  );
}
