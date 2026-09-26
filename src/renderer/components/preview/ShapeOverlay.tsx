/**
 * ShapeOverlay — direct manipulation over the preview frame.
 *
 * Click a shape to select it, drag its body to move it, drag a corner to
 * resize (opposite corner pinned), drag the top-edge handle to rotate; arrow
 * keys nudge the selected shape while the overlay holds focus. Upstream
 * `TransformOverlayView` only draws handles for an already-selected clip and
 * has no rotate handle (rotation lives in its Inspector) — click-to-select and
 * the rotate handle are Windows additions; the handle geometry, the
 * opposite-corner-pinned resize, and the position/scale/rotate split follow
 * the upstream view and `TransformOverlayMathTests`.
 *
 * Every pointermove recomputes the whole gesture from the start snapshot plus
 * the total pointer delta, undoes the previous transient, and re-applies
 * through `applyClipProperties` — the timeline drag pattern, so a long drag
 * cannot drift and pointerup leaves exactly one undo entry. A press that ends
 * where it began applies an unchanged draft, which the controller skips, so
 * it adds no history at all. Escape (or pointercancel) drops the transient;
 * Escape then continues to the global deselect, one keypress for both.
 *
 * All geometry lives in `lib/shape-overlay`; this file only wires pointers,
 * focus, selection, and the store.
 */

import React, { useEffect, useRef } from 'react';
import { useTimelineStore } from '../../store/timeline';
import { hasShapeContent } from '../../../shared/editor/shape';
import type { Clip } from '../../../shared/types/project';
import {
  HANDLE_HIT_RADIUS_PX,
  HANDLE_SCREEN_PX,
  ROTATE_HIT_RADIUS_PX,
  ROTATE_OFFSET_SCREEN_PX,
  ROTATE_SCREEN_PX,
  boxCorners,
  clientToProject,
  effectiveBox,
  hitTestOverlay,
  moveBox,
  projectPerScreen,
  resizeBox,
  rotateBox,
  rotateHandlePoint,
  type CornerId,
  type EffectiveBox,
  type OverlayHit,
  type ProjectPoint,
} from '../../lib/shape-overlay';

interface ShapeOverlayProps {
  /** Project canvas size (viewBox units). */
  width: number;
  height: number;
  /** Displayed size in CSS pixels, matching the canvas element. */
  displayWidth: number;
  displayHeight: number;
}

type Gesture =
  | {
    mode: 'move' | 'rotate';
    pointerId: number;
    clipId: string;
    startBox: EffectiveBox;
    startPointer: ProjectPoint;
    hasApplied: boolean;
  }
  | {
    mode: 'resize';
    corner: CornerId;
    pointerId: number;
    clipId: string;
    startBox: EffectiveBox;
    startPointer: ProjectPoint;
    hasApplied: boolean;
  };

/** Base step per arrow key in project px; Shift multiplies by ten. */
const ARROW_DELTAS: Readonly<Record<string, { x: number; y: number }>> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  // Project y grows downward, so Up decreases y.
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

function cursorForHit(hit: OverlayHit | null): string {
  if (!hit) return '';
  if (hit.kind === 'rotate') return 'grab';
  if (hit.kind === 'body') return 'move';
  return hit.kind === 'nw' || hit.kind === 'se' ? 'nwse-resize' : 'nesw-resize';
}

export function ShapeOverlay({
  width,
  height,
  displayWidth,
  displayHeight,
}: ShapeOverlayProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<Gesture | null>(null);

  // Plain selectors: each returns a cached reference until the controller
  // actually replaces it, so this stays within useSyncExternalStore's rules.
  const activeTimelineId = useTimelineStore((state) => state.activeTimelineId);
  const selectedClipIds = useTimelineStore((state) => state.selectedClipIds);
  const project = useTimelineStore((state) => state.project);

  const enabled =
    activeTimelineId === null && displayWidth > 0 && displayHeight > 0;
  const tracks = project.timeline.tracks;
  const playhead = project.timeline.playheadFrame;

  // Chrome: exactly one selected clip, and it is a shape drawn at the root
  // playhead on an unlocked, visible track.
  const selectedId =
    selectedClipIds.size === 1 ? [...selectedClipIds][0]! : null;
  const chromeClip = selectedId
    ? project.timeline.clips.find((clip) => clip.id === selectedId) ?? null
    : null;
  const chromeTrack = chromeClip
    ? tracks.find((track) => track.id === chromeClip.trackId) ?? null
    : null;
  const chromeActive =
    enabled &&
    !!chromeClip &&
    chromeClip.type === 'shape' &&
    !!chromeTrack &&
    !chromeTrack.locked &&
    chromeTrack.visible !== false &&
    playhead >= chromeClip.startFrame &&
    playhead < chromeClip.startFrame + chromeClip.durationFrames;
  const chromeBox: EffectiveBox | null =
    chromeActive && chromeClip ? effectiveBox(chromeClip, playhead) : null;

  // Hit-test bodies: visible unlocked shapes with something drawn, plus the
  // selected clip even when empty (so it stays grabbable). Topmost first —
  // the preview draws by ascending track order (stable within a track, later
  // clip on top), so reverse that order here.
  const bodyClips = project.timeline.clips
    .filter((clip) => {
      if (clip.type !== 'shape') return false;
      const track = tracks.find((candidate) => candidate.id === clip.trackId);
      if (!track || track.locked || track.visible === false) return false;
      if (
        playhead < clip.startFrame ||
        playhead >= clip.startFrame + clip.durationFrames
      ) {
        return false;
      }
      return hasShapeContent(clip) || selectedClipIds.has(clip.id);
    })
    .sort((a, b) => {
      const orderA = tracks.find((track) => track.id === a.trackId)?.order ?? 0;
      const orderB = tracks.find((track) => track.id === b.trackId)?.order ?? 0;
      return orderA - orderB;
    })
    .reverse();
  const bodies = bodyClips.map((clip) => ({
    clipId: clip.id,
    box: effectiveBox(clip, playhead),
  }));

  const screenScale = projectPerScreen(displayWidth, width);
  const chromeHit = chromeBox
    ? {
      box: chromeBox,
      cornerRadius: HANDLE_HIT_RADIUS_PX * screenScale,
      rotateRadius: ROTATE_HIT_RADIUS_PX * screenScale,
      rotateOffset: ROTATE_OFFSET_SCREEN_PX * screenScale,
    }
    : null;

  // Undo a still-applied transient if the overlay goes away mid-gesture.
  useEffect(
    () => () => {
      const gesture = gestureRef.current;
      gestureRef.current = null;
      if (gesture?.hasApplied) {
        useTimelineStore.getState().controller.undo();
      }
    },
    [],
  );

  const clientToWrapPoint = (
    clientX: number,
    clientY: number,
  ): ProjectPoint | null => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return clientToProject(clientX, clientY, rect, width, height);
  };

  const hitAt = (point: ProjectPoint): OverlayHit | null =>
    hitTestOverlay(point, chromeHit, bodies);

  const cancelGesture = () => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    if (gesture?.hasApplied) {
      useTimelineStore.getState().controller.undo();
    }
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !enabled || gestureRef.current) return;
    const point = clientToWrapPoint(event.clientX, event.clientY);
    if (!point) return;
    const hit = hitAt(point);
    if (!hit) return; // Empty frame press: ignored, nothing underneath needs it.

    wrapRef.current?.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);

    if (hit.kind === 'body') {
      const state = useTimelineStore.getState();
      if (!(state.selectedClipIds.size === 1 && state.selectedClipIds.has(hit.clipId))) {
        state.selectClip(hit.clipId);
      }
      const startBox =
        bodies.find((body) => body.clipId === hit.clipId)?.box ?? null;
      if (!startBox) return;
      gestureRef.current = {
        mode: 'move',
        pointerId: event.pointerId,
        clipId: hit.clipId,
        startBox,
        startPointer: point,
        hasApplied: false,
      };
      return;
    }

    // Handle hits act on the chrome (the single selected shape).
    if (!chromeBox || !chromeClip) return;
    gestureRef.current =
      hit.kind === 'rotate'
        ? {
          mode: 'rotate',
          pointerId: event.pointerId,
          clipId: chromeClip.id,
          startBox: chromeBox,
          startPointer: point,
          hasApplied: false,
        }
        : {
          mode: 'resize',
          corner: hit.kind,
          pointerId: event.pointerId,
          clipId: chromeClip.id,
          startBox: chromeBox,
          startPointer: point,
          hasApplied: false,
        };
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (gesture) {
      if (event.pointerId !== gesture.pointerId) return;
      const point = clientToWrapPoint(event.clientX, event.clientY);
      if (!point) return;
      const { controller } = useTimelineStore.getState();
      if (gesture.hasApplied) controller.undo();

      let next: Partial<Clip>;
      let label: string;
      if (gesture.mode === 'move') {
        const moved = moveBox(
          gesture.startBox,
          point.x - gesture.startPointer.x,
          point.y - gesture.startPointer.y,
        );
        next = { x: moved.x, y: moved.y };
        label = 'Move shape';
      } else if (gesture.mode === 'resize') {
        const resized = resizeBox(gesture.startBox, gesture.corner, point);
        next = {
          x: resized.x,
          y: resized.y,
          width: resized.width,
          height: resized.height,
        };
        label = 'Resize shape';
      } else {
        next = {
          rotation: rotateBox(gesture.startBox, gesture.startPointer, point),
        };
        label = 'Rotate shape';
      }

      const report = controller.applyClipProperties(
        [gesture.clipId],
        label,
        (draft) => {
          if (next.x !== undefined) draft.x = next.x;
          if (next.y !== undefined) draft.y = next.y;
          if (next.width !== undefined) draft.width = next.width;
          if (next.height !== undefined) draft.height = next.height;
          if (next.rotation !== undefined) draft.rotation = next.rotation;
          return true;
        },
      );
      gesture.hasApplied = report.changedClipIds.length > 0;
      return;
    }

    // Hover: park the cursor on whatever handle or body sits under the pointer.
    if (!enabled || !wrapRef.current) return;
    const point = clientToWrapPoint(event.clientX, event.clientY);
    wrapRef.current.style.cursor = point ? cursorForHit(hitAt(point)) : '';
  };

  const endGesture = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    // Keep whatever the last step applied — that is the gesture's one entry.
    gestureRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const point = clientToWrapPoint(event.clientX, event.clientY);
    event.currentTarget.style.cursor = point ? cursorForHit(hitAt(point)) : '';
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;

    if (event.key === 'Escape') {
      // In flight: drop the transient, then let the event reach the global
      // handler so one Escape also clears the selection. Idle: pass through.
      if (gestureRef.current) cancelGesture();
      return;
    }

    const delta = ARROW_DELTAS[event.key];
    if (!delta) return;
    if (gestureRef.current) {
      // Mid-drag arrows are swallowed so a nudge cannot fight the gesture.
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!chromeActive || !chromeClip || !chromeBox) return; // Playhead keeps the key.
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 10 : 1;
    const nudged = moveBox(chromeBox, delta.x * step, delta.y * step);
    useTimelineStore.getState().controller.applyClipProperties(
      [chromeClip.id],
      'Nudge shape',
      (draft) => {
        draft.x = nudged.x;
        draft.y = nudged.y;
        return true;
      },
    );
  };

  if (!enabled) return null;

  const corners = chromeBox ? boxCorners(chromeBox) : null;
  const boxPoints = corners
    ? `${corners.nw.x},${corners.nw.y} ${corners.ne.x},${corners.ne.y} ${corners.se.x},${corners.se.y} ${corners.sw.x},${corners.sw.y}`
    : '';
  const handleSize = HANDLE_SCREEN_PX * screenScale;
  const rotatePoint = chromeBox
    ? rotateHandlePoint(chromeBox, ROTATE_OFFSET_SCREEN_PX * screenScale)
    : null;

  return (
    <div
      ref={wrapRef}
      role="group"
      aria-label="Shape transform"
      tabIndex={chromeActive ? 0 : -1}
      data-shape-overlay=""
      data-shape-chrome={chromeActive ? '' : undefined}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
      onKeyDown={handleKeyDown}
      className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 touch-none focus:outline-none focus-visible:outline-2 focus-visible:outline-accent"
      style={{ width: `${displayWidth}px`, height: `${displayHeight}px` }}
    >
      {/* Decorative chrome: handles are drawn here, but every hit test runs
          in JS against the same geometry, so the SVG stays pointer-transparent. */}
      {chromeBox && corners && rotatePoint && (
        <svg
          // Handles convey nothing a screen reader can use; the Inspector
          // exposes the same transforms as labelled fields.
          aria-hidden="true"
          focusable="false"
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          className="pointer-events-none absolute inset-0 h-full w-full"
        >
          {/* Two passes per stroke: dark under light, readable over any frame. */}
          <g
            fill="none"
            stroke="rgba(0,0,0,0.55)"
            strokeWidth={3}
            vectorEffect="non-scaling-stroke"
          >
            <polygon points={boxPoints} />
          </g>
          <g
            fill="none"
            stroke="rgba(255,255,255,0.75)"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          >
            <polygon points={boxPoints} />
          </g>
          {(['nw', 'ne', 'sw', 'se'] as const).map((id) => (
            <rect
              key={id}
              x={corners[id].x - handleSize / 2}
              y={corners[id].y - handleSize / 2}
              width={handleSize}
              height={handleSize}
              fill="#ffffff"
              stroke="rgba(0,0,0,0.9)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          <circle
            cx={rotatePoint.x}
            cy={rotatePoint.y}
            r={(ROTATE_SCREEN_PX * screenScale) / 2}
            fill="#ffffff"
            stroke="rgba(0,0,0,0.9)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      )}
    </div>
  );
}
