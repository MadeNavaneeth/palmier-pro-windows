/**
 * GuideOverlay — composition guides drawn over the preview frame (#167).
 *
 * An SVG sized to the displayed frame with a unit viewBox, so the shared
 * normalized geometry can be used directly and the guides track the canvas
 * exactly as it is scaled to fit. `vector-effect: non-scaling-stroke` keeps the
 * hairlines one device pixel wide at any zoom, instead of a fat blur when the
 * frame is scaled up and an invisible line when it is scaled down.
 *
 * Purely a viewing aid: it sits above the canvas in the DOM and is never part of
 * the composited or exported frame.
 */

import React from 'react';
import { guideGeometry, type GuideKind } from '../../../shared/preview/guides';

interface GuideOverlayProps {
  /** Enabled guides. */
  guides: ReadonlySet<GuideKind>;
  /** Project canvas size, needed to keep the centre cross square. */
  width: number;
  height: number;
  /** Displayed size in CSS pixels, matching the canvas element. */
  displayWidth: number;
  displayHeight: number;
}

export function GuideOverlay({
  guides,
  width,
  height,
  displayWidth,
  displayHeight,
}: GuideOverlayProps) {
  if (guides.size === 0 || displayWidth <= 0 || displayHeight <= 0) return null;

  const { lines, rects } = guideGeometry(guides, { width, height });
  if (lines.length === 0 && rects.length === 0) return null;

  return (
    <svg
      // Decorative: the guides convey nothing a screen reader can use, and the
      // controls that toggle them are already labelled.
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 1 1"
      preserveAspectRatio="none"
      width={displayWidth}
      height={displayHeight}
      // Centred explicitly to line up with the centred canvas, rather than
      // relying on the static position of an absolute child of a flex box.
      // pointer-events-none keeps the frame area usable as a drop target.
      className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
      style={{ width: `${displayWidth}px`, height: `${displayHeight}px` }}
    >
      {/* Two passes per shape: a dark line under a light one, so guides stay
          readable over both blown-out and near-black footage. */}
      <g
        fill="none"
        stroke="rgba(0,0,0,0.55)"
        strokeWidth={3}
        vectorEffect="non-scaling-stroke"
      >
        {rects.map((rect) => (
          <rect
            key={`shadow-rect-${rect.x}`}
            x={rect.x}
            y={rect.y}
            width={rect.width}
            height={rect.height}
          />
        ))}
        {lines.map((line) => (
          <line
            key={`shadow-line-${line.x1}-${line.y1}-${line.x2}-${line.y2}`}
            x1={line.x1}
            y1={line.y1}
            x2={line.x2}
            y2={line.y2}
          />
        ))}
      </g>
      <g
        fill="none"
        stroke="rgba(255,255,255,0.75)"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      >
        {rects.map((rect) => (
          <rect
            key={`rect-${rect.x}`}
            x={rect.x}
            y={rect.y}
            width={rect.width}
            height={rect.height}
          />
        ))}
        {lines.map((line) => (
          <line
            key={`line-${line.x1}-${line.y1}-${line.x2}-${line.y2}`}
            x1={line.x1}
            y1={line.y1}
            x2={line.x2}
            y2={line.y2}
          />
        ))}
      </g>
    </svg>
  );
}
