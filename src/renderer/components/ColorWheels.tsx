/**
 * Color-wheels editor (upstream #157, `ColorWheelControl` + `ColorWheelPad`).
 *
 * One pad per zone (Lift/Gamma/Gain) side by side, each with its hue vector
 * plus its master offset below — upstream's zone model 1:1, with no tab
 * switching: all three zones stay visible, like upstream's HStack. A pad drag
 * steers the puck and commits on release; double-click resets the pad color
 * to center (the master is untouched, as upstream); each master slider
 * commits once per drag. Nothing is written until a gesture ends, so one
 * gesture is one undo step and Escape can drop it -- the project only ever
 * sees wheels the model's invariants already hold for (see `lib/color-wheels`).
 *
 * The wheel face is painted once from the pipeline's own hue math, so the
 * face, the puck position, and the grade can never disagree about which angle
 * is which hue. The face is content color and stays put in both themes; rings,
 * labels, and controls use the same tokens as the curve editor.
 */

import React, { useEffect, useId, useRef, useState } from 'react';
import {
  COLOR_GRADE_WHEEL_LIMITS,
  GRADE_WHEEL_ZONES,
  gradeWheelsEqual,
  type ColorWheelZone,
  type GradeWheels,
  type GradeWheelZone,
} from '../../shared/editor/color-grade';
import {
  WHEEL_DRAG_THRESHOLD,
  WHEEL_FACE_SIZE,
  WHEEL_NUDGE_STEP,
  isDefaultWheelZone,
  moveWheelPuck,
  resetWheelZone,
  setWheelMaster,
  wheelFacePixel,
  wheelPixelToValue,
  wheelValueToPixel,
} from '../lib/color-wheels';

const ZONE_LABELS: Record<GradeWheelZone, string> = {
  lift: 'Lift',
  gamma: 'Gamma',
  gain: 'Gain',
};

/** Lift's master is an offset; gamma/gain masters are multipliers. */
function formatWheelMaster(zone: GradeWheelZone, m: number): string {
  if (zone === 'lift') return m === 0 ? '0' : `${m > 0 ? '+' : ''}${m.toFixed(2)}`;
  return `${m.toFixed(2)}×`;
}

const KEY_DELTAS: Record<string, { x: number; y: number }> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: 1 },
  ArrowDown: { x: 0, y: -1 },
};

export function ColorWheels({
  wheels,
  onCommit,
}: {
  wheels: GradeWheels;
  onCommit: (next: GradeWheels, label: string) => void;
}) {
  const hintId = useId();

  const commitPad = (zone: GradeWheelZone, x: number, y: number) => {
    const next = moveWheelPuck(wheels, zone, x, y);
    // A grab that ends where it started is not an edit: without this a mouse
    // jiggle would add an identical undo entry.
    if (gradeWheelsEqual(next, wheels)) return;
    onCommit(next, `Adjust ${ZONE_LABELS[zone]}`);
  };

  const commitMaster = (zone: GradeWheelZone, m: number) => {
    const next = setWheelMaster(wheels, zone, m);
    if (gradeWheelsEqual(next, wheels)) return;
    onCommit(next, `Change ${ZONE_LABELS[zone]}`);
  };

  const resetZone = (zone: GradeWheelZone) => {
    const next = resetWheelZone(wheels, zone);
    if (gradeWheelsEqual(next, wheels)) return;
    onCommit(next, `Reset ${ZONE_LABELS[zone]} wheel`);
  };

  return (
    <div className="flex flex-col gap-1.5 border-t border-white/10 pt-2" data-wheels-editor>
      <span className="text-2xs uppercase tracking-wide text-text-muted">Color Wheels</span>

      <div className="flex gap-2">
        {GRADE_WHEEL_ZONES.map((zone) => {
          const label = ZONE_LABELS[zone];
          return (
            <div key={zone} className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex items-center justify-between">
                <span className="text-2xs text-text-muted uppercase tracking-wide">{label}</span>
                {!isDefaultWheelZone(wheels, zone) && (
                  <button
                    type="button"
                    onClick={() => resetZone(zone)}
                    data-wheel-reset={zone}
                    aria-label={`Reset the ${label} wheel`}
                    className="text-2xs text-text-muted underline decoration-dotted transition hover:text-text-secondary"
                  >
                    Reset
                  </button>
                )}
              </div>
              <WheelPad
                zone={zone}
                label={label}
                value={wheels[zone]}
                hintId={hintId}
                onCommitPad={commitPad}
              />
              <WheelMaster
                zone={zone}
                label={label}
                value={wheels[zone].m}
                onCommitMaster={commitMaster}
              />
            </div>
          );
        })}
      </div>

      <p id={hintId} className="text-[10px] text-text-muted">
        Drag the puck to steer hue and strength · double-click resets color · arrow keys nudge
      </p>
    </div>
  );
}

/**
 * In-flight pad gesture. `pending` is a press that has not travelled far
 * enough to move the puck yet, so a plain click leaves the wheels untouched.
 */
type WheelDrag =
  | { pointerId: number; startX: number; startY: number; mode: 'pending' }
  | { pointerId: number; startX: number; startY: number; mode: 'pad'; x: number; y: number };

function WheelPad({
  zone,
  label,
  value,
  hintId,
  onCommitPad,
}: {
  zone: GradeWheelZone;
  label: string;
  value: ColorWheelZone;
  hintId: string;
  onCommitPad: (zone: GradeWheelZone, x: number, y: number) => void;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const faceRef = useRef<HTMLCanvasElement | null>(null);
  const [drag, setDrag] = useState<WheelDrag | null>(null);

  const shown = drag?.mode === 'pad' ? { x: drag.x, y: drag.y } : value;
  const centered = Math.sqrt(shown.x * shown.x + shown.y * shown.y) < 0.05;

  // The face never changes: paint it once from the shared hue math.
  useEffect(() => {
    const canvas = faceRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const image = ctx.createImageData(WHEEL_FACE_SIZE, WHEEL_FACE_SIZE);
    const c = WHEEL_FACE_SIZE / 2;
    for (let j = 0; j < WHEEL_FACE_SIZE; j += 1) {
      for (let i = 0; i < WHEEL_FACE_SIZE; i += 1) {
        const [r, g, b, a] = wheelFacePixel((i - c) / c, (c - j) / c);
        const o = (j * WHEEL_FACE_SIZE + i) * 4;
        image.data[o] = Math.trunc(Math.min(255, Math.max(0, r * 255)));
        image.data[o + 1] = Math.trunc(Math.min(255, Math.max(0, g * 255)));
        image.data[o + 2] = Math.trunc(Math.min(255, Math.max(0, b * 255)));
        image.data[o + 3] = Math.trunc(Math.min(255, Math.max(0, a * 255)));
      }
    }
    ctx.putImageData(image, 0, 0);
  }, []);

  /** Pointer position in pad pixels, or null before the box is measured. */
  const localPixels = (event: { clientX: number; clientY: number }):
    { rect: DOMRect; x: number; y: number } | null => {
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return { rect, x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const local = localPixels(event);
    if (!local) return;
    // The pad keeps the keyboard for the gesture, so Escape and the arrow
    // keys land here rather than on the workspace.
    boxRef.current?.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ pointerId: event.pointerId, startX: local.x, startY: local.y, mode: 'pending' });
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const local = localPixels(event);
    if (!local) return;
    if (Math.hypot(local.x - drag.startX, local.y - drag.startY) < WHEEL_DRAG_THRESHOLD) return;
    const next = wheelPixelToValue(local.x, local.y, local.rect.width, local.rect.height);
    setDrag({ ...drag, mode: 'pad', x: next.x, y: next.y });
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (drag.mode === 'pad') onCommitPad(zone, drag.x, drag.y);
    setDrag(null);
  };

  const handleDoubleClick = () => {
    // Upstream resets the pad color, keeping the master where it is.
    onCommitPad(zone, 0, 0);
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
    // Arrow keys are global frame-step shortcuts; the focused pad consumes
    // them so a nudge cannot also move the playhead. The commit clamps onto
    // the disk, like a pointer landing past the rim.
    event.preventDefault();
    event.stopPropagation();
    onCommitPad(
      zone,
      value.x + delta.x * WHEEL_NUDGE_STEP,
      value.y + delta.y * WHEEL_NUDGE_STEP,
    );
  };

  const pos = wheelValueToPixel(shown.x, shown.y, 100, 100);
  const positionLabel = centered
    ? 'centered'
    : `x ${shown.x.toFixed(2)}, y ${shown.y.toFixed(2)}`;

  return (
    <div
      ref={boxRef}
      role="group"
      tabIndex={0}
      aria-label={`${label} color wheel, ${positionLabel}`}
      aria-describedby={hintId}
      data-wheel-pad={zone}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => setDrag(null)}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
      className="relative aspect-square w-full cursor-crosshair touch-none rounded-sm border border-transparent focus:border-accent focus:outline-none"
    >
      <canvas
        ref={faceRef}
        aria-hidden="true"
        width={WHEEL_FACE_SIZE}
        height={WHEEL_FACE_SIZE}
        className="absolute inset-0 h-full w-full rounded-full"
      />
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 h-full w-full"
        viewBox="0 0 100 100"
      >
        <g className="text-white/10" stroke="currentColor" strokeWidth={1}>
          <line x1={0} y1={50} x2={100} y2={50} vectorEffect="non-scaling-stroke" />
          <line x1={50} y1={0} x2={50} y2={100} vectorEffect="non-scaling-stroke" />
        </g>
        <circle
          cx={50}
          cy={50}
          r={49}
          fill="none"
          className="text-white/20"
          stroke="currentColor"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <span
        aria-hidden="true"
        data-wheel-puck
        data-wheel-puck-zone={zone}
        className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-surface-0 bg-white"
        style={{ left: `${pos.x}%`, top: `${pos.y}%` }}
      />
    </div>
  );
}

/**
 * One zone's master offset. A pointer drag streams into local state and
 * commits once on release; a keyboard step commits immediately, like every
 * other slider's arrow keys. Escape drops an in-flight drag.
 */
function WheelMaster({
  zone,
  label,
  value,
  onCommitMaster,
}: {
  zone: GradeWheelZone;
  label: string;
  value: number;
  onCommitMaster: (zone: GradeWheelZone, m: number) => void;
}) {
  const dragging = useRef(false);
  const [draft, setDraft] = useState<number | null>(null);
  const limits = COLOR_GRADE_WHEEL_LIMITS[zone].m;
  const shown = draft ?? value;

  const handlePointerUp = () => {
    dragging.current = false;
    if (draft !== null) {
      onCommitMaster(zone, draft);
      setDraft(null);
    }
  };

  return (
    <div className="flex items-center gap-1">
      <input
        type="range"
        min={limits.min}
        max={limits.max}
        step={0.01}
        value={shown}
        aria-label={`${label} master`}
        data-wheel-master={zone}
        className="min-w-0 flex-1 accent-accent"
        onPointerDown={(event) => {
          dragging.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (dragging.current) setDraft(next);
          else onCommitMaster(zone, next);
        }}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => {
          dragging.current = false;
          setDraft(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && draft !== null) {
            event.preventDefault();
            event.stopPropagation();
            dragging.current = false;
            setDraft(null);
          }
        }}
      />
      <span className="w-8 shrink-0 text-right text-2xs tabular-nums text-text-secondary">
        {formatWheelMaster(zone, shown)}
      </span>
    </div>
  );
}
