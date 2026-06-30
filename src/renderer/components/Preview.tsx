/**
 * Preview — the main preview panel with canvas, transport controls,
 * and playback engine integration.
 */

import React, { useEffect, useRef, useCallback } from 'react';
import { PreviewCanvas } from './PreviewCanvas';
import { useTimelineStore } from '../store/timeline';
import { getPlaybackEngine } from '../engine/PlaybackEngine';
import { frameToTimecode } from '../../shared/utils/time';

export function Preview() {
  const isPlaying = useTimelineStore((s) => s.isPlaying);
  const playhead = useTimelineStore((s) => s.project.timeline.playheadFrame);
  const fps = useTimelineStore((s) => s.getProjectFps());
  const togglePlayback = useTimelineStore((s) => s.togglePlayback);
  const stepFrame = useTimelineStore((s) => s.stepFrame);
  const width = useTimelineStore((s) => s.project.settings.width);
  const height = useTimelineStore((s) => s.project.settings.height);
  const playbackRate = useTimelineStore((s) => s.playbackRate);

  const engine = useRef(getPlaybackEngine());

  // Sync playback engine with store state
  useEffect(() => {
    if (isPlaying) {
      engine.current.start();
    } else {
      engine.current.stop();
    }
  }, [isPlaying]);

  // Request composite when playhead moves (for scrub/seek)
  useEffect(() => {
    if (!isPlaying) {
      engine.current.seek(playhead);
    }
  }, [playhead, isPlaying]);

  // Cleanup
  useEffect(() => {
    return () => engine.current.dispose();
  }, []);

  const handleTogglePlay = useCallback(() => {
    togglePlayback();
  }, [togglePlayback]);

  const timecode = frameToTimecode(playhead, fps);

  return (
    <section className="flex flex-1 flex-col bg-surface-0">
      {/* Preview canvas */}
      <PreviewCanvas width={width} height={height} />

      {/* Transport bar */}
      <div className="flex items-center justify-between border-t border-surface-3 bg-surface-1 px-4 py-2">
        {/* Left: Timecode */}
        <div className="w-32">
          <span className="font-mono text-xs text-text-primary tabular-nums">
            {timecode}
          </span>
        </div>

        {/* Center: Transport buttons */}
        <div className="flex items-center gap-3">
          {/* Previous frame */}
          <button
            onClick={() => stepFrame(-1)}
            className="flex h-7 w-7 items-center justify-center rounded text-text-secondary transition hover:bg-surface-3 hover:text-text-primary"
            title="Previous frame (←)"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
              <rect x="1" y="2" width="2" height="8" />
              <polygon points="11,2 11,10 4,6" />
            </svg>
          </button>

          {/* Play/Pause */}
          <button
            onClick={handleTogglePlay}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-accent text-white transition hover:bg-accent-hover"
            title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
          >
            {isPlaying ? (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
                <rect x="2" y="1" width="3" height="10" />
                <rect x="7" y="1" width="3" height="10" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
                <polygon points="2,0 12,6 2,12" />
              </svg>
            )}
          </button>

          {/* Next frame */}
          <button
            onClick={() => stepFrame(1)}
            className="flex h-7 w-7 items-center justify-center rounded text-text-secondary transition hover:bg-surface-3 hover:text-text-primary"
            title="Next frame (→)"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
              <polygon points="1,2 1,10 8,6" />
              <rect x="9" y="2" width="2" height="8" />
            </svg>
          </button>
        </div>

        {/* Right: Playback rate indicator */}
        <div className="w-32 text-right">
          {playbackRate !== 1 && (
            <span className="text-2xs text-accent tabular-nums">
              {playbackRate > 0 ? '▶' : '◀'} {Math.abs(playbackRate)}x
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
