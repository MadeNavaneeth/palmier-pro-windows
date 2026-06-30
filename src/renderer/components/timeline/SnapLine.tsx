/**
 * SnapLine — visual feedback when a clip snaps to an alignment point.
 * A thin dashed vertical line that appears during drag when snapping occurs.
 */

import React from 'react';
import { useSnapIndicator } from '../../hooks/useSnapIndicator';

export function SnapLine() {
  const snap = useSnapIndicator();

  if (!snap.active) return null;

  return (
    <div
      className="absolute top-0 bottom-0 z-20 pointer-events-none"
      style={{ left: `${snap.pixelX}px` }}
    >
      <div className="h-full w-px border-l border-dashed border-yellow-400/80" />
    </div>
  );
}
