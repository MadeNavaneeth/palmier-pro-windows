/**
 * PlayheadIndicator — the vertical red line indicating current playback position.
 * Renders as an absolute-positioned element spanning the full track height.
 */

import React from 'react';
import { useTimelineStore } from '../../store/timeline';

export function PlayheadIndicator() {
  const playheadFrame = useTimelineStore((s) => s.project.timeline.playheadFrame);
  const viewport = useTimelineStore((s) => s.viewport);

  const x = (playheadFrame - viewport.scrollFrame) * viewport.pixelsPerFrame;

  // Don't render if off-screen
  if (x < -2 || x > 4000) return null;

  return (
    <div
      className="absolute top-0 bottom-0 z-30 pointer-events-none"
      style={{ left: `${x}px` }}
    >
      {/* Head triangle */}
      <div className="absolute -top-0 -translate-x-1/2 w-0 h-0 border-l-[5px] border-r-[5px] border-t-[6px] border-l-transparent border-r-transparent border-t-red-500" />
      {/* Line */}
      <div className="absolute top-0 bottom-0 w-px bg-red-500 -translate-x-px" />
    </div>
  );
}
