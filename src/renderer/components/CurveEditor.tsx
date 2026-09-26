/**
 * Tone-curves editor (upstream #157, `CurveEditorView`).
 *
 * One channel at a time (Master/R/G/B) over the shared `GradeCurve` model.
 * A drag grabs the nearest point or drops a new one at the press location,
 * then moves it; a double-click removes an interior point; the channel's
 * Reset clears it. Nothing is written until a gesture ends, so one drag is
 * one undo step and Escape can drop it -- the project only ever sees a curve
 * the model's invariants already hold for (see `lib/curve-editor`).
 *
 * The backdrop is the quarter grid and dashed identity diagonal upstream
 * draws. Its histogram layer has no counterpart here: this port's preview
 * does not expose one, and the pipeline has no other source for it.
 */

import React, { useId, useRef, useState } from 'react';
import {
  COLOR_GRADE_CURVE_LIMITS,
  evalCurve,
  gradeCurvesEqual,
  isIdentityPoints,
  type CurvePoint,
  type GradeCurve,
  type GradeCurveChannel,
} from '../../shared/editor/color-grade';
import {
  CURVE_DRAG_THRESHOLD,
  CURVE_NUDGE_STEP,
  addCurvePoint,
  curveEditorPoints,
  curvePixelToPoint,
  findNearestCurvePoint,
  moveCurvePoint,
  removeCurvePoint,
  withCurveChannel,
} from '../lib/curve-editor';

/** Editor height in pixels, upstream's `AppTheme.Curve.editorHeight`. */
const EDITOR_HEIGHT = 180;

/** Samples per curve path; upstream strides its stroke at the same 0.02. */
const PATH_STEPS = 50;

const CHANNELS: ReadonlyArray<{
  channel: GradeCurveChannel;
  label: string;
  /** Curve stroke / active tab tint, keyed to the model channel. */
  stroke: string;
  dot: string;
  text: string;
}> = [
  { channel: 'master', label: 'Master', stroke: 'stroke-text-secondary', dot: 'bg-text-secondary', text: 'text-text-secondary' },
  { channel: 'red', label: 'R', stroke: 'stroke-red-400', dot: 'bg-red-400', text: 'text-red-400' },
  { channel: 'green', label: 'G', stroke: 'stroke-green-400', dot: 'bg-green-400', text: 'text-green-400' },
  { channel: 'blue', label: 'B', stroke: 'stroke-blue-400', dot: 'bg-blue-400', text: 'text-blue-400' },
];

const KEY_DELTAS: Record<string, { x: number; y: number }> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: 1 },
  ArrowDown: { x: 0, y: -1 },
};

/**
 * In-flight gesture. `pending` is a press that has not travelled far enough to
 * become a new point yet, so a plain click leaves the curve untouched.
 */
type CurveDrag =
  | { pointerId: number; startX: number; startY: number; mode: 'pending' }
  | { pointerId: number; startX: number; startY: number; mode: 'point'; points: CurvePoint[]; index: number };

export function CurveEditor({
  curve,
  onCommit,
}: {
  curve: GradeCurve;
  onCommit: (next: GradeCurve, label: string) => void;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const hintId = useId();
  const [channel, setChannel] = useState<GradeCurveChannel>('master');
  const [drag, setDrag] = useState<CurveDrag | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  const active = CHANNELS.find((entry) => entry.channel === channel)!;
  const committed = curveEditorPoints(curve[channel]);
  const points = drag?.mode === 'point' ? drag.points : committed;
  const atCap = points.length >= COLOR_GRADE_CURVE_LIMITS.maxPointsPerChannel;

  /** Pointer position in editor pixels, or null before the box is measured. */
  const localPixels = (event: { clientX: number; clientY: number }):
    { rect: DOMRect; x: number; y: number } | null => {
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return { rect, x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const commit = (nextPoints: readonly CurvePoint[], label: string) => {
    const next = withCurveChannel(curve, channel, nextPoints);
    // A grab that ends where it started is not an edit: without this a mouse
    // jiggle would add an identical undo entry.
    if (gradeCurvesEqual(next, curve)) return;
    onCommit(next, label);
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const local = localPixels(event);
    if (!local) return;
    // The graph keeps the keyboard for the gesture, so Escape and the arrow
    // keys land here rather than on the workspace.
    boxRef.current?.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    const index = findNearestCurvePoint(committed, local.x, local.y, local.rect.width, local.rect.height);
    if (index === null) {
      setDrag({ pointerId: event.pointerId, startX: local.x, startY: local.y, mode: 'pending' });
      setSelected(null);
    } else {
      setDrag({ pointerId: event.pointerId, startX: local.x, startY: local.y, mode: 'point', points: committed, index });
      setSelected(index);
    }
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const local = localPixels(event);
    if (!local) return;
    const toPoint = (x: number, y: number) => curvePixelToPoint(x, y, local.rect.width, local.rect.height);
    if (drag.mode === 'pending') {
      if (Math.hypot(local.x - drag.startX, local.y - drag.startY) < CURVE_DRAG_THRESHOLD) return;
      // Upstream grabs at the press location, then moves the new point to the
      // pointer; the press x is what decides where it lands in the channel.
      const inserted = addCurvePoint(committed, toPoint(drag.startX, drag.startY));
      if (!inserted) {
        // At the point cap, or tight against a neighbour: leave the curve as is.
        setDrag(null);
        return;
      }
      setSelected(inserted.index);
      setDrag({
        ...drag,
        mode: 'point',
        index: inserted.index,
        points: moveCurvePoint(inserted.points, inserted.index, toPoint(local.x, local.y)),
      });
      return;
    }
    setDrag({ ...drag, points: moveCurvePoint(drag.points, drag.index, toPoint(local.x, local.y)) });
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (drag.mode === 'point') commit(drag.points, 'Edit curves');
    setDrag(null);
  };

  const handleDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const local = localPixels(event);
    if (!local) return;
    const index = findNearestCurvePoint(committed, local.x, local.y, local.rect.width, local.rect.height);
    if (index === null) return;
    const removed = removeCurvePoint(committed, index);
    if (!removed) return;
    commit(removed, 'Edit curves');
    setSelected(null);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Escape') {
      if (!drag) return; // Nothing in flight: Escape still clears the selection.
      event.preventDefault();
      event.stopPropagation();
      setDrag(null);
      return;
    }
    const delta = KEY_DELTAS[event.key];
    if (!delta || drag) return;
    const index = selected ?? (committed.length > 2 ? 1 : 0);
    const point = committed[index];
    if (!point) return;
    // Arrow keys are global frame-step shortcuts; the focused graph consumes
    // them so a nudge cannot also move the playhead.
    event.preventDefault();
    event.stopPropagation();
    setSelected(index);
    commit(
      moveCurvePoint(committed, index, {
        x: point.x + delta.x * CURVE_NUDGE_STEP,
        y: point.y + delta.y * CURVE_NUDGE_STEP,
      }),
      'Edit curves',
    );
  };

  const path = Array.from({ length: PATH_STEPS + 1 }, (_, index) => {
    const x = index / PATH_STEPS;
    const y = evalCurve(points, x);
    return `${index === 0 ? 'M' : 'L'} ${(x * 100).toFixed(2)} ${((1 - y) * 100).toFixed(2)}`;
  }).join(' ');

  return (
    <div className="flex flex-col gap-1.5 border-t border-white/10 pt-2" data-curve-editor>
      <div className="flex items-center justify-between">
        <span className="text-2xs uppercase tracking-wide text-text-muted">Curves</span>
        {!isIdentityPoints(points) && (
          <button
            type="button"
            onClick={() => {
              commit([], 'Reset curves');
              setSelected(null);
            }}
            data-curve-reset={channel}
            aria-label={`Reset the ${active.label} curve`}
            className="text-2xs text-text-muted underline decoration-dotted transition hover:text-text-secondary"
          >
            Reset
          </button>
        )}
      </div>

      <div role="group" aria-label="Curve channel" className="flex gap-0.5">
        {CHANNELS.map((entry) => (
          <button
            key={entry.channel}
            type="button"
            aria-pressed={entry.channel === channel}
            data-curve-tab={entry.channel}
            onClick={() => {
              setChannel(entry.channel);
              setSelected(null);
            }}
            className={`flex-1 rounded border px-1 py-0.5 text-[9px] transition ${
              entry.channel === channel
                ? `border-surface-4 bg-surface-3 ${entry.text}`
                : 'border-surface-3 bg-surface-2 text-text-muted hover:bg-surface-3 hover:text-text-secondary'
            }`}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div
        ref={boxRef}
        role="group"
        tabIndex={0}
        aria-label={`${active.label} curve editor, ${isIdentityPoints(points) ? 'identity' : `${points.length} points`}`}
        aria-describedby={hintId}
        data-curve-channel={channel}
        style={{ height: EDITOR_HEIGHT }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => setDrag(null)}
        onDoubleClick={handleDoubleClick}
        onKeyDown={handleKeyDown}
        className="relative w-full cursor-crosshair touch-none rounded border border-surface-3 bg-surface-2 focus:border-accent focus:outline-none"
      >
        <svg
          aria-hidden="true"
          className="absolute inset-0 h-full w-full"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
        >
          <g className="text-white/10" stroke="currentColor" strokeWidth={1}>
            {[25, 50, 75].map((value) => (
              <line key={`v${value}`} x1={value} y1={0} x2={value} y2={100} vectorEffect="non-scaling-stroke" />
            ))}
            {[25, 50, 75].map((value) => (
              <line key={`h${value}`} x1={0} y1={value} x2={100} y2={value} vectorEffect="non-scaling-stroke" />
            ))}
          </g>
          <line
            className="text-white/20"
            stroke="currentColor"
            strokeWidth={1}
            strokeDasharray="3 3"
            vectorEffect="non-scaling-stroke"
            x1={0}
            y1={100}
            x2={100}
            y2={0}
          />
          <path
            className={active.stroke}
            d={path}
            fill="none"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>

        {points.map((point, index) => (
          <span
            key={index}
            aria-hidden="true"
            data-curve-point={index}
            data-curve-point-selected={index === selected ? 'true' : undefined}
            className={`pointer-events-none absolute h-[9px] w-[9px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-surface-0 ${active.dot} ${
              index === selected ? 'ring-2 ring-accent' : ''
            }`}
            style={{ left: `${point.x * 100}%`, top: `${(1 - point.y) * 100}%` }}
          />
        ))}
      </div>

      <p id={hintId} className="text-[10px] text-text-muted">
        {atCap
          ? `Point limit reached (${COLOR_GRADE_CURVE_LIMITS.maxPointsPerChannel} per channel).`
          : 'Drag to add or shape a point · double-click to remove · arrow keys nudge'}
      </p>
    </div>
  );
}
