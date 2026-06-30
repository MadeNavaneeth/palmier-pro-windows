/**
 * TimelineRuler — frame/timecode ruler at the top of the timeline.
 * Shows tick marks and time labels, click to position playhead.
 */

import React, { useCallback, useMemo } from 'react';
import { useTimelineStore } from '../../store/timeline';
import { frameToTimecode } from '../../../shared/utils/time';

interface TimelineRulerProps {
  width: number;
}

export function TimelineRuler({ width }: TimelineRulerProps) {
  const viewport = useTimelineStore((s) => s.viewport);
  const fps = useTimelineStore((s) => s.getProjectFps());
  const setPlayhead = useTimelineStore((s) => s.setPlayhead);
  const startDrag = useTimelineStore((s) => s.startDrag);

  // Calculate tick interval based on zoom level
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

  // Generate visible ticks
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

  return (
    <div
      className="relative h-6 border-b border-surface-3 bg-surface-2 cursor-pointer select-none overflow-hidden"
      onMouseDown={handleMouseDown}
    >
      <svg width={width} height={24} className="absolute inset-0">
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
      </svg>
    </div>
  );
}
