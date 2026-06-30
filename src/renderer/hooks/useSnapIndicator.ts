/**
 * useSnapIndicator — tracks whether a snap just occurred during a drag,
 * providing the snapped frame for visual feedback (the snap line).
 */

import { useMemo } from 'react';
import { useTimelineStore } from '../store/timeline';

export interface SnapIndicator {
  active: boolean;
  frame: number;
  pixelX: number;
}

export function useSnapIndicator(): SnapIndicator {
  const drag = useTimelineStore((s) => s.drag);
  const viewport = useTimelineStore((s) => s.viewport);
  const project = useTimelineStore((s) => s.project);

  return useMemo(() => {
    if (drag.mode !== 'move' || !drag.clipId) {
      return { active: false, frame: 0, pixelX: 0 };
    }

    // Find the clip's current position
    const clip = project.timeline.clips.find((c) => c.id === drag.clipId);
    if (!clip) return { active: false, frame: 0, pixelX: 0 };

    // Check if the current position aligns with a snap point
    const snapPoints = useTimelineStore.getState().getSnapPoints(drag.clipId);
    const threshold = useTimelineStore.getState().snapThresholdFrames;

    for (const point of snapPoints) {
      // Check clip start against snap point
      if (Math.abs(clip.startFrame - point.frame) < 1) {
        const pixelX = (point.frame - viewport.scrollFrame) * viewport.pixelsPerFrame;
        return { active: true, frame: point.frame, pixelX };
      }
      // Check clip end against snap point
      const clipEnd = clip.startFrame + clip.durationFrames;
      if (Math.abs(clipEnd - point.frame) < 1) {
        const pixelX = (point.frame - viewport.scrollFrame) * viewport.pixelsPerFrame;
        return { active: true, frame: point.frame, pixelX };
      }
    }

    return { active: false, frame: 0, pixelX: 0 };
  }, [drag.mode, drag.clipId, project.timeline.clips, viewport]);
}
