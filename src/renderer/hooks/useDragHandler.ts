/**
 * useDragHandler — global mouse move/up listener for timeline drag operations.
 * Handles move, trim-left, trim-right, and playhead scrub drag modes.
 * Attaches to window to capture mouse even when dragging outside the timeline.
 */

import { useEffect, useCallback, useRef } from 'react';
import { useTimelineStore } from '../store/timeline';

export function useDragHandler() {
  const drag = useTimelineStore((s) => s.drag);
  const updateDrag = useTimelineStore((s) => s.updateDrag);
  const endDrag = useTimelineStore((s) => s.endDrag);
  const cancelDrag = useTimelineStore((s) => s.cancelDrag);
  const viewport = useTimelineStore((s) => s.viewport);
  const setPlayhead = useTimelineStore((s) => s.setPlayhead);

  const isDragging = drag.mode !== 'none';
  const rafRef = useRef<number>(0);
  const lastXRef = useRef<number>(0);

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isDragging) return;
      lastXRef.current = e.clientX;

      // Use requestAnimationFrame to throttle updates to 60fps
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;

        if (drag.mode === 'playhead') {
          // Playhead scrub doesn't go through the command system
          const deltaPixels = lastXRef.current - drag.startX;
          const deltaFrames = Math.round(deltaPixels / viewport.pixelsPerFrame);
          const newFrame = Math.max(0, drag.startFrame + deltaFrames);
          setPlayhead(newFrame);
        } else {
          updateDrag(lastXRef.current);
        }
      });
    },
    [isDragging, drag.mode, drag.startX, drag.startFrame, viewport.pixelsPerFrame, updateDrag, setPlayhead],
  );

  const handleMouseUp = useCallback(
    (e: MouseEvent) => {
      if (!isDragging) return;
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
      endDrag();
    },
    [isDragging, endDrag],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!isDragging) return;
      if (e.key === 'Escape') {
        if (rafRef.current) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = 0;
        }
        cancelDrag();
      }
    },
    [isDragging, cancelDrag],
  );

  useEffect(() => {
    if (!isDragging) return;

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('keydown', handleKeyDown);

    // Prevent text selection during drag
    document.body.style.userSelect = 'none';
    document.body.style.cursor =
      drag.mode === 'move' ? 'grabbing' :
      drag.mode === 'trim-left' || drag.mode === 'trim-right' ? 'col-resize' :
      drag.mode === 'playhead' ? 'ew-resize' : 'default';

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('keydown', handleKeyDown);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, [isDragging, handleMouseMove, handleMouseUp, handleKeyDown, drag.mode]);
}
