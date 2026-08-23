/**
 * Timeline â€” the main timeline panel assembling ruler, tracks, clips,
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

/**
 * @param fill Take all the height the parent offers instead of the fixed panel
 *   height. Set by the `vertical` workspace preset when nothing else shares the
 *   timeline's column, matching upstream, where collapsing a split view item hands
 *   its space to the remaining siblings rather than leaving a hole.
 */
export function Timeline({ fill = false }: { fill?: boolean } = {}) {
  const tracks = useTimelineStore((s) => s.getTracks());
  const clips = useTimelineStore((s) => s.getClips());
  const addTrack = useTimelineStore((s) => s.addTrack);
  const viewport = useTimelineStore((s) => s.viewport);
  const scrollTo = useTimelineStore((s) => s.scrollTo);
  const setViewportWidth = useTimelineStore((s) => s.setViewportWidth);
  const beginMarquee = useTimelineStore((s) => s.beginMarquee);
  const applyMarqueeRegion = useTimelineStore((s) => s.applyMarqueeRegion);
  const endMarquee = useTimelineStore((s) => s.endMarquee);

  const tracksContainerRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(800);

  // Sort tracks: video (higher order on top), audio at bottom. Display order
  // is what marquee row math maps against.
  const sortedTracks = [...tracks].sort((a, b) => b.order - a.order);
  /** Lane row height â€” must match the h-12 track rows. */
  const TRACK_ROW_HEIGHT = 48;

  // Rubber-band marquee state in client coordinates; the band can cross
  // tracks, so geometry lives here rather than in a single lane.
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const marqueeRef = useRef(marquee);
  marqueeRef.current = marquee;
  const marqueeGeometry = useRef({ pixelsPerFrame: viewport.pixelsPerFrame, scrollFrame: viewport.scrollFrame });
  marqueeGeometry.current = { pixelsPerFrame: viewport.pixelsPerFrame, scrollFrame: viewport.scrollFrame };

  const handleLaneMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      beginMarquee(e.shiftKey);
      setMarquee({ x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY });

      const applyRegion = (m: { x0: number; y0: number; x1: number; y1: number }) => {
        const container = lanesRef.current?.getBoundingClientRect();
        if (!container) return;
        const { pixelsPerFrame, scrollFrame } = marqueeGeometry.current;
        const frameOf = (clientX: number) =>
          Math.max(0, Math.round((clientX - container.left) / pixelsPerFrame) + scrollFrame);
        const startFrame = Math.min(frameOf(m.x0), frameOf(m.x1));
        const endFrame = Math.max(frameOf(m.x0), frameOf(m.x1));
        const rowIndex = (clientY: number) =>
          Math.floor((clientY - container.top) / TRACK_ROW_HEIGHT);
        const from = Math.min(rowIndex(m.y0), rowIndex(m.y1));
        const to = Math.max(rowIndex(m.y0), rowIndex(m.y1));
        const trackIds = new Set(
          sortedTracks.slice(Math.max(0, from), to + 1).map((track) => track.id),
        );
        applyMarqueeRegion(startFrame, Math.max(startFrame + 1, endFrame), trackIds);
      };

      const onMove = (event: MouseEvent) => {
        const next = { ...marqueeRef.current!, x1: event.clientX, y1: event.clientY };
        setMarquee(next);
        applyRegion(next);
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        endMarquee();
        setMarquee(null);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [beginMarquee, applyMarqueeRegion, endMarquee, sortedTracks],
  );

  // Activate global hooks
  useDragHandler();
  useKeyboardShortcuts();

  // Offline-media detection: refresh whenever the project's media list or
  // any asset path can have changed (import, relink, open, undo of relink).
  const mediaSignature = useTimelineStore((s) =>
    s.project.media.map((a) => a.path).join('|'),
  );
  const refreshOfflineStatus = useTimelineStore((s) => s.refreshOfflineStatus);
  useEffect(() => {
    void refreshOfflineStatus();
  }, [mediaSignature, refreshOfflineStatus]);

  // Follow-playhead (R2): keep the playhead visible during playback by
  // adjusting scrollFrame when it approaches either edge of the viewport.
  const isPlaying = useTimelineStore((s) => s.isPlaying);
  const playheadFrame = useTimelineStore((s) => s.project.timeline.playheadFrame);
  useEffect(() => {
    if (!isPlaying) return;
    const container = tracksContainerRef.current;
    if (!container) return;
    const visibleFrames = container.clientWidth / viewport.pixelsPerFrame;
    const margin = visibleFrames * 0.1; // 10% edge padding
    const relativePos = playheadFrame - viewport.scrollFrame;

    if (relativePos > visibleFrames - margin) {
      scrollTo(Math.max(0, Math.round(playheadFrame - visibleFrames * 0.9)));
    } else if (relativePos < 0) {
      scrollTo(Math.max(0, Math.round(playheadFrame - visibleFrames * 0.1)));
    }
  }, [isPlaying, playheadFrame, viewport.pixelsPerFrame, viewport.scrollFrame, scrollTo]);

  // Track container width for the ruler, and publish it so fit-to-window works
  // from the toolbar and the keyboard, neither of which can see this element.
  useEffect(() => {
    const el = tracksContainerRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
        setViewportWidth(entry.contentRect.width);
      }
    });
    observer.observe(el);
    setViewportWidth(el.clientWidth);
    return () => observer.disconnect();
  }, [setViewportWidth]);

  // Horizontal scroll handler
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (e.shiftKey || (e.deltaX !== 0 && !e.ctrlKey)) {
        // Horizontal scroll
        const deltaFrames = Math.round((e.deltaX || e.deltaY) / viewport.pixelsPerFrame);
        scrollTo(viewport.scrollFrame + deltaFrames);
        e.preventDefault();
      } else if (e.ctrlKey) {
        // Zoom with ctrl+wheel, anchored at the cursor position so the frame
        // under the pointer stays under the pointer after zooming (NLE convention).
        e.preventDefault();
        const rect = tracksContainerRef.current?.getBoundingClientRect();
        if (!rect) return;
        const cursorX = e.clientX - rect.left;
        const frameAtCursor = viewport.scrollFrame + cursorX / viewport.pixelsPerFrame;
        const zoomFactor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        const newPxPerFrame = Math.max(
          viewport.minPxPerFrame,
          Math.min(viewport.maxPxPerFrame, viewport.pixelsPerFrame * zoomFactor),
        );
        const newScrollFrame = Math.max(0, frameAtCursor - cursorX / newPxPerFrame);
        useTimelineStore.setState({
          viewport: { ...viewport, pixelsPerFrame: newPxPerFrame, scrollFrame: newScrollFrame },
        });
      }
    },
    [viewport, scrollTo],
  );

  return (
    // `min-h-*` comes from exactly one branch: Tailwind resolves duplicate
    // properties by stylesheet order, not class order, so listing it in the base
    // string as well would make the winner depend on build output.
    <section
      className={`flex flex-col overflow-hidden bg-surface-1 ${
        fill ? 'min-h-0 flex-1' : 'h-[270px] min-h-[160px] shrink-0'
      }`}
    >
      <div className="panel-header flex items-center px-2">
        <div className="flex h-full items-center gap-1 border-b border-white/80 px-2 text-[10px] font-medium text-text-primary">
          Timeline 1
        </div>
      </div>

      <TimelineToolbar />

      {/* Tracks area */}
      <div className="flex flex-1 overflow-hidden" onWheel={handleWheel}>
        {/* Track headers (labels) */}
        <div className="flex w-[116px] flex-shrink-0 flex-col border-r border-white/10 bg-surface-2">
          {/* Ruler spacer */}
          <div className="h-6 border-b border-white/10" />
          {/* Track headers */}
          {sortedTracks.map((track) => (
            <TrackHeader key={track.id} track={track} />
          ))}
          {/* Add track button */}
          <div className="flex items-center gap-1 px-2 py-1">
            <button
              onClick={() => addTrack('video')}
              className="rounded px-1 py-0.5 text-[9px] text-text-muted transition hover:bg-white/[0.08] hover:text-text-primary"
              title="Add video track"
            >
              +V
            </button>
            <button
              onClick={() => addTrack('audio')}
              className="rounded px-1 py-0.5 text-[9px] text-text-muted transition hover:bg-white/[0.08] hover:text-text-primary"
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
          <div ref={lanesRef} className="relative">
            {sortedTracks.map((track) => (
              <TimelineTrack
                key={track.id}
                track={track}
                clips={clips.filter((c) => c.trackId === track.id)}
                onLaneMouseDown={handleLaneMouseDown}
              />
            ))}

            {/* Rubber-band selection rect (R1 marquee). */}
            {marquee && lanesRef.current && (
              <div
                data-marquee-rect
                className="absolute z-20 border border-accent/80 bg-accent/10 pointer-events-none"
                style={{
                  left: Math.min(marquee.x0, marquee.x1) - lanesRef.current.getBoundingClientRect().left,
                  top: Math.min(marquee.y0, marquee.y1) - lanesRef.current.getBoundingClientRect().top,
                  width: Math.abs(marquee.x1 - marquee.x0),
                  height: Math.abs(marquee.y1 - marquee.y0),
                }}
              />
            )}

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
