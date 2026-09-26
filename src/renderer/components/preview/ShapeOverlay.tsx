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
 * the total pointer delta and previews it through `applyClipProperties`, which
 * applies it without publishing — the timeline drag pattern, so a long drag
 * cannot drift and the frame that is on screen is always the pointer's. Only
 * pointerup publishes, re-running that same step through the normal path, so
 * the gesture leaves exactly one undo entry; Escape drops the transient and
 * then continues to the global deselect, one keypress for both. A press that
 * ends where it began applies an unchanged draft, which the controller skips,
 * so it adds no history at all.
 *
 * Frames never reach the undo history, so closing one cannot consume a
 * neighbouring entry — an AI edit adopted from main mid-gesture survives the
 * gesture instead of being reverted by its next pointermove.
 *
 * All geometry lives in `lib/shape-overlay`; the frame protocol below is the
 * gesture's history contract, and this file wires pointers, focus, and
 * selection around it.
 */

import React, { useEffect, useRef } from 'react';
import { scopeTimelineOf, useTimelineStore } from '../../store/timeline';
import { hasShapeContent } from '../../../shared/editor/shape';
import type { Clip, Timeline } from '../../../shared/types/project';
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

/**
 * One staged preview frame: the edited scope as it stood before and after the
 * frame currently on screen, and the scope it was measured in.
 *
 * This is the gesture's private staging area. The frame was applied without
 * publishing, so closing it (the next move, Escape, teardown, or the release
 * that commits it) restores only what the frame itself wrote and leaves the
 * shared undo history alone.
 */
export interface ShapeGestureFrame {
  before: Timeline;
  after: Timeline;
  scopeId: string | null;
}

type GestureBase = {
  pointerId: number;
  clipId: string;
  startBox: EffectiveBox;
  startPointer: ProjectPoint;
  /** Pointer position of the last processed move; the commit re-derives it. */
  lastPoint: ProjectPoint;
  /** The frame on screen, or null when no frame is applied. */
  frame: ShapeGestureFrame | null;
};

export type Gesture =
  | (GestureBase & { mode: 'move' | 'rotate' })
  | (GestureBase & { mode: 'resize'; corner: CornerId });

/**
 * Close the staged preview frame, if one is on screen.
 *
 * The collapse reverts exactly what that frame wrote, so an edit adopted while
 * the gesture was in flight survives it — including one in this scope, which a
 * whole-scope restore would take with it.
 */
export function collapseShapeGestureFrame(gesture: Gesture): void {
  const frame = gesture.frame;
  if (!frame) return;
  gesture.frame = null;
  useTimelineStore.getState().controller.collapsePreviewFrame(frame.before, frame.after, frame.scopeId);
}

/** What this pointer position means for the gesture, re-derived from its start. */
function shapeGestureStep(gesture: Gesture, point: ProjectPoint): { next: Partial<Clip>; label: string } {
  if (gesture.mode === 'move') {
    const moved = moveBox(
      gesture.startBox,
      point.x - gesture.startPointer.x,
      point.y - gesture.startPointer.y,
    );
    return { next: { x: moved.x, y: moved.y }, label: 'Move shape' };
  }
  if (gesture.mode === 'resize') {
    const resized = resizeBox(gesture.startBox, gesture.corner, point);
    return {
      next: { x: resized.x, y: resized.y, width: resized.width, height: resized.height },
      label: 'Resize shape',
    };
  }
  return {
    next: { rotation: rotateBox(gesture.startBox, gesture.startPointer, point) },
    label: 'Rotate shape',
  };
}

/**
 * One gesture frame, applied through `applyClipProperties`.
 *
 * `commit` picks between the two uses of that one call: a move PREVIEWS it —
 * applied to the live project and published nowhere — and pointerup re-runs the
 * identical step through the normal path, so the gesture lands as exactly one
 * undo entry carrying the label the step itself names, captured at the moment
 * the user let go.
 */
export function applyShapeGestureFrame(gesture: Gesture, point: ProjectPoint, commit: boolean): void {
  // Whatever is on screen right now is replaced by this frame, including the
  // step that changes nothing: the controller skips an unchanged draft, so a
  // gesture that returns to where it began ends up having moved nothing.
  collapseShapeGestureFrame(gesture);

  const { next, label } = shapeGestureStep(gesture, point);
  const { controller } = useTimelineStore.getState();
  const run = () => controller.applyClipProperties([gesture.clipId], label, (draft) => {
    if (next.x !== undefined) draft.x = next.x;
    if (next.y !== undefined) draft.y = next.y;
    if (next.width !== undefined) draft.width = next.width;
    if (next.height !== undefined) draft.height = next.height;
    if (next.rotation !== undefined) draft.rotation = next.rotation;
    return true;
  });

  if (commit) {
    run();
    return;
  }

  const scopeId = controller.getActiveTimelineId();
  const before = scopeTimelineOf(controller.getProject(), scopeId);
  const report = controller.previewFrame(run);
  const after = scopeTimelineOf(controller.getProject(), scopeId);
  // Whether the frame actually wrote anything, rather than whether the mutator
  // was merely reached: an unchanged draft stages nothing to close.
  if (report.changedClipIds.length > 0) gesture.frame = { before, after, scopeId };
}

/**
 * Pointer release: the staged frame becomes the gesture's one undo entry.
 *
 * Re-running the last step through the normal path (rather than publishing the
 * previewed one) is deliberate. The previewed command captured its "previous"
 * state when the frame was applied, so publishing it would make one undo of the
 * gesture restore a project from before any edit adopted mid-gesture. Taking
 * the capture now means undoing the gesture spares that edit.
 */
export function commitShapeGesture(gesture: Gesture): void {
  if (!gesture.frame) return;
  applyShapeGestureFrame(gesture, gesture.lastPoint, true);
}

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

  // Teardown is not a release: there is no pointerup, so the user never
  // completed this gesture and never saw it commit. Drop the staged frame
  // without publishing, so a panel that goes away mid-drag cannot leave the
  // transient applied with no history behind it — and cannot reach for an
  // unrelated entry to remove it. These helpers read only their arguments and
  // the store, so the first render's closures are the ones teardown needs.
  useEffect(
    () => () => {
      const gesture = gestureRef.current;
      gestureRef.current = null;
      if (gesture) collapseShapeGestureFrame(gesture);
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
    if (gesture) collapseShapeGestureFrame(gesture);
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
        lastPoint: point,
        frame: null,
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
          lastPoint: point,
          frame: null,
        }
        : {
          mode: 'resize',
          corner: hit.kind,
          pointerId: event.pointerId,
          clipId: chromeClip.id,
          startBox: chromeBox,
          startPointer: point,
          lastPoint: point,
          frame: null,
        };
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (gesture) {
      if (event.pointerId !== gesture.pointerId) return;
      const point = clientToWrapPoint(event.clientX, event.clientY);
      if (!point) return;
      gesture.lastPoint = point;
      applyShapeGestureFrame(gesture, point, false);
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
    gestureRef.current = null;
    // Publish the gesture's one entry, or nothing at all when no frame was
    // staged. Pointercancel lands here too, so an interrupted drag keeps the
    // step it had reached rather than dropping it.
    commitShapeGesture(gesture);
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
