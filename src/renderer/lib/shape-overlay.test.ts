/**
 * Shape-overlay geometry and gesture math (canvas direct manipulation).
 *
 * Pins the rules the overlay commits through `applyClipProperties`: display ↔
 * project mapping, compositor-mirrored effective boxes (motion wins), the
 * round-trip transform pair handles are drawn with, hit priority
 * (rotate > corner > topmost body), and each whole-gesture result — including
 * the unchanged-ending exactness that lets a press with no real movement add
 * no undo history. Upstream: `TransformOverlayView.swift` (move + four-corner
 * resize; the rotate handle is a Windows addition).
 */

import { describe, it, expect } from 'vitest';
import {
  HANDLE_HIT_RADIUS_PX,
  ROTATE_HIT_RADIUS_PX,
  ROTATE_OFFSET_SCREEN_PX,
  SHAPE_MIN_SIZE,
  boxCorners,
  boxPivot,
  boxToWorld,
  clientToProject,
  effectiveBox,
  hitTestOverlay,
  moveBox,
  pointInBox,
  projectPerScreen,
  rotateBox,
  rotateHandlePoint,
  resizeBox,
  worldToBox,
  type EffectiveBox,
} from './shape-overlay';

/** Short alias so handle tests read cleanly. */
const rotateHandle = rotateHandlePoint;

const DEG = Math.PI / 180;

/** Identity box helper: full field set, defaults that need no overrides. */
function box(overrides: Partial<EffectiveBox> = {}): EffectiveBox {
  return {
    x: 100,
    y: 50,
    width: 200,
    height: 100,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    anchorX: 0,
    anchorY: 0,
    ...overrides,
  };
}

const STATIC_CLIP = {
  x: 10,
  y: 20,
  width: 200,
  height: 100,
  rotation: 15,
  scaleX: 1.5,
  scaleY: 0.8,
  anchorX: 40,
  anchorY: 25,
};

describe('clientToProject', () => {
  it('maps the overlay rect corners and centre onto the project frame', () => {
    const rect = { left: 10, top: 20, width: 400, height: 200 };
    expect(clientToProject(10, 20, rect, 1920, 1080)).toEqual({ x: 0, y: 0 });
    expect(clientToProject(410, 220, rect, 1920, 1080)).toEqual({ x: 1920, y: 1080 });
    expect(clientToProject(210, 120, rect, 1920, 1080)).toEqual({ x: 960, y: 540 });
  });

  it('survives a not-yet-measured rect', () => {
    const rect = { left: 0, top: 0, width: 0, height: 0 };
    expect(clientToProject(5, 5, rect, 1920, 1080)).toEqual({ x: 0, y: 0 });
  });
});

describe('projectPerScreen', () => {
  it('scales screen px into the viewBox and survives a zero display', () => {
    expect(projectPerScreen(400, 1920)).toBe(4.8);
    expect(projectPerScreen(0, 1920)).toBe(1);
  });
});

describe('effectiveBox', () => {
  it('falls back to static fields when no motion track exists', () => {
    expect(effectiveBox(STATIC_CLIP, 42)).toEqual(STATIC_CLIP);
  });

  it('lets motion tracks win per axis at the playhead frame', () => {
    const clip = {
      ...STATIC_CLIP,
      motionX: [
        { frame: 0, value: 0 },
        { frame: 100, value: 200 },
      ],
      motionRot: [
        { frame: 0, value: 0 },
        { frame: 100, value: 90 },
      ],
    };
    const at = effectiveBox(clip, 50);
    expect(at.x).toBe(100); // linear midpoint of the track, not static x
    expect(at.rotation).toBe(45);
    expect(at.y).toBe(STATIC_CLIP.y); // untouched axis keeps the static field
    expect(at.scaleX).toBe(STATIC_CLIP.scaleX);
    expect(at.anchorX).toBe(STATIC_CLIP.anchorX);
  });

  it('ignores an empty track and keeps the static field', () => {
    expect(effectiveBox({ ...STATIC_CLIP, motionX: [] }, 10).x).toBe(STATIC_CLIP.x);
  });
});

describe('boxPivot / boxToWorld / worldToBox', () => {
  it('pivots at position + anchor', () => {
    expect(boxPivot(box({ x: 10, y: 20, anchorX: 5, anchorY: 6 }))).toEqual({ x: 15, y: 26 });
  });

  it('round-trips local → world → local under rotation, scale and anchor', () => {
    const b = box({ rotation: 37, scaleX: 1.5, scaleY: 0.8, anchorX: 40, anchorY: 25 });
    for (const [lx, ly] of [
      [0, 0],
      [200, 100],
      [37, 12],
    ] as const) {
      const world = boxToWorld(b, lx, ly);
      const back = worldToBox(b, world);
      expect(back.x).toBeCloseTo(lx, 9);
      expect(back.y).toBeCloseTo(ly, 9);
    }
  });

  it('identity box maps local corners straight onto x/y offsets', () => {
    const b = box();
    expect(boxToWorld(b, 0, 0)).toEqual({ x: 100, y: 50 });
    expect(boxToWorld(b, 200, 100)).toEqual({ x: 300, y: 150 });
  });
});

describe('boxCorners / pointInBox', () => {
  it('places identity corners at the axis-aligned rectangle', () => {
    const corners = boxCorners(box());
    expect(corners).toEqual({
      nw: { x: 100, y: 50 },
      ne: { x: 300, y: 50 },
      sw: { x: 100, y: 150 },
      se: { x: 300, y: 150 },
    });
  });

  it('misses a rotated box at a point still inside its axis-aligned bounds', () => {
    const diamond = box({ x: 0, y: 0, width: 100, height: 100, rotation: 45 });
    expect(pointInBox(diamond, { x: 0, y: 70 })).toBe(true); // centre region
    expect(pointInBox(diamond, { x: 70, y: 5 })).toBe(false); // AABB corner, outside the diamond
    expect(pointInBox(box(), { x: 150, y: 100 })).toBe(true);
    expect(pointInBox(box(), { x: 99, y: 100 })).toBe(false);
  });
});

describe('rotateHandlePoint', () => {
  it('stands the handle off the top-edge midpoint for an identity box', () => {
    const handle = rotateHandle(box(), 16);
    expect(handle).toEqual({ x: 200, y: 50 - 16 }); // mid-x = 100 + 200/2
  });

  it('stays perpendicular to the top edge under rotation', () => {
    const b = box({ rotation: 37, scaleX: 1.5, scaleY: 0.8 });
    const nw = boxCorners(b).nw;
    const ne = boxCorners(b).ne;
    const mid = boxToWorld(b, b.width / 2, 0);
    const centre = boxToWorld(b, b.width / 2, b.height / 2);
    const handle = rotateHandle(b, 25);
    const outX = handle.x - mid.x;
    const outY = handle.y - mid.y;
    expect(Math.hypot(outX, outY)).toBeCloseTo(25, 9);
    // Offset runs along the centre → edge ray (outward, not inward)…
    const rayX = mid.x - centre.x;
    const rayY = mid.y - centre.y;
    expect(outX * rayX + outY * rayY).toBeGreaterThan(0);
    expect(outX * rayY - outY * rayX).toBeCloseTo(0, 6); // collinear with the ray
    // …and is perpendicular to the edge itself (nw → ne).
    const edgeX = ne.x - nw.x;
    const edgeY = ne.y - nw.y;
    expect(outX * edgeX + outY * edgeY).toBeCloseTo(0, 6);
  });
});

describe('hitTestOverlay', () => {
  const chrome = {
    box: box(),
    cornerRadius: HANDLE_HIT_RADIUS_PX,
    rotateRadius: ROTATE_HIT_RADIUS_PX,
    rotateOffset: ROTATE_OFFSET_SCREEN_PX,
  };
  const coveringBody = { clipId: 'shape-a', box: box({ x: 0, y: 0, width: 1000, height: 1000 }) };

  it('prefers the rotate handle over corners and bodies', () => {
    const handle = rotateHandle(chrome.box, chrome.rotateOffset);
    expect(hitTestOverlay(handle, chrome, [coveringBody])).toEqual({ kind: 'rotate' });
  });

  it('prefers a corner handle over a body under it', () => {
    expect(hitTestOverlay({ x: 100, y: 50 }, chrome, [coveringBody])).toEqual({ kind: 'nw' });
    expect(hitTestOverlay({ x: 300, y: 150 }, chrome, [coveringBody])).toEqual({ kind: 'se' });
  });

  it('hits the topmost body when several overlap (caller passes topmost-first)', () => {
    const under = { clipId: 'under', box: box() };
    const over = { clipId: 'over', box: box() };
    expect(hitTestOverlay({ x: 150, y: 80 }, null, [over, under])).toEqual({
      kind: 'body',
      clipId: 'over',
    });
  });

  it('returns null over empty space, and misses handles outside their radii', () => {
    expect(hitTestOverlay({ x: 900, y: 900 }, chrome, [])).toBeNull(); // outside box + handles
    expect(hitTestOverlay({ x: 0, y: 0 }, null, [])).toBeNull();
    const handle = rotateHandle(chrome.box, chrome.rotateOffset);
    const beyond = { x: handle.x + ROTATE_HIT_RADIUS_PX + 1, y: handle.y };
    expect(hitTestOverlay(beyond, chrome, [])).toBeNull();
  });
});

describe('moveBox', () => {
  it('shifts every rendered point by the rounded delta, whatever the rotation', () => {
    const start = box({ rotation: 37, scaleX: 1.5, scaleY: 0.8, anchorX: 40, anchorY: 25 });
    const moved = { ...start, ...moveBox(start, 4.6, -2.4) };
    const dx = Math.round(4.6); // 5
    const dy = Math.round(-2.4); // -2
    const before = boxCorners(start);
    const after = boxCorners(moved);
    for (const id of ['nw', 'ne', 'sw', 'se'] as const) {
      expect(after[id].x).toBeCloseTo(before[id].x + dx, 9);
      expect(after[id].y).toBeCloseTo(before[id].y + dy, 9);
    }
  });

  it('reproduces the start position for a press that ends where it began', () => {
    const start = box();
    expect(moveBox(start, 0.4, -0.4)).toEqual({ x: start.x, y: start.y });
    expect(moveBox(start, 0, 0)).toEqual({ x: start.x, y: start.y });
  });
});

describe('resizeBox', () => {
  it('drags the se corner while pinning nw for an identity box', () => {
    const start = box();
    // Opposite (nw) stays at (100, 50); extent becomes 300×200 under the pointer.
    expect(resizeBox(start, 'se', { x: 400, y: 250 })).toEqual({
      x: 100,
      y: 50,
      width: 300,
      height: 200,
    });
  });

  it('drags the nw corner while pinning se for an identity box', () => {
    const start = box();
    const result = resizeBox(start, 'nw', { x: 150, y: 80 });
    expect(result).toEqual({ x: 150, y: 80, width: 150, height: 70 });
    // The pinned se corner does not move.
    expect(result.x + result.width).toBe(300);
    expect(result.y + result.height).toBe(150);
  });

  it('pins the opposite corner in world space under rotation and scale', () => {
    const start = box({ rotation: 37, scaleX: 2, scaleY: 2 });
    const oppositeStart = boxCorners(start).nw;
    // Build the pointer from a target 300×150 extent so rounding is exact:
    // local reach from the pinned nw is R·S·(300, 150).
    const rad = 37 * DEG;
    const rx = 300 * 2;
    const ry = 150 * 2;
    const pointer = {
      x: oppositeStart.x + rx * Math.cos(rad) - ry * Math.sin(rad),
      y: oppositeStart.y + rx * Math.sin(rad) + ry * Math.cos(rad),
    };
    const result = resizeBox(start, 'se', pointer);
    expect(result.width).toBe(300);
    expect(result.height).toBe(150);
    const oppositeEnd = boxCorners({ ...start, ...result }).nw;
    expect(oppositeEnd.x).toBeCloseTo(oppositeStart.x, 6);
    expect(oppositeEnd.y).toBeCloseTo(oppositeStart.y, 6);
  });

  it('divides the rotated-frame reach by scale', () => {
    const start = box({ scaleX: 2, scaleY: 2 }); // rotation 0: pointer reach / 2 = extent
    expect(resizeBox(start, 'se', { x: 100 + 600, y: 50 + 400 })).toEqual({
      x: 100,
      y: 50,
      width: 300,
      height: 200,
    });
  });

  it('snaps back to the start box for a press that barely moved', () => {
    const start = box();
    const startBox = { x: start.x, y: start.y, width: start.width, height: start.height };
    expect(resizeBox(start, 'se', { x: 300.3, y: 150.2 })).toEqual(startBox);
    expect(resizeBox(start, 'nw', { x: 100.4, y: 50.4 })).toEqual(startBox);
  });

  it('never shrinks below the minimum size', () => {
    const start = box();
    const collapsed = resizeBox(start, 'se', { x: 100.2, y: 50.2 }); // dragged past the opposite
    expect(collapsed.width).toBe(SHAPE_MIN_SIZE);
    expect(collapsed.height).toBe(SHAPE_MIN_SIZE);
  });
});

describe('rotateBox', () => {
  it('sweeps 90° around the pivot when the pointer quarter-turns', () => {
    const start = box();
    const pivot = boxPivot(start); // (100, 50) for the identity box
    const onRight = { x: pivot.x + 100, y: pivot.y };
    const below = { x: pivot.x, y: pivot.y + 100 }; // atan2 y-down: +90°
    expect(rotateBox(start, onRight, below)).toBe(start.rotation + 90);
  });

  it('adds the swept delta to a non-zero start rotation, rounded to 0.1°', () => {
    const start = box({ rotation: 30 });
    const pivot = boxPivot(start);
    const startPointer = { x: pivot.x + 100, y: pivot.y };
    const target = 45.64;
    const pointer = {
      x: pivot.x + 100 * Math.cos(target * DEG),
      y: pivot.y + 100 * Math.sin(target * DEG),
    };
    expect(rotateBox(start, startPointer, pointer)).toBe(75.6); // 30 + round(45.64→45.6)
  });

  it('normalizes a pointer crossing the ±π seam into a small step', () => {
    const start = box();
    const pivot = boxPivot(start);
    const at = (deg: number) => ({
      x: pivot.x + 100 * Math.cos(deg * DEG),
      y: pivot.y + 100 * Math.sin(deg * DEG),
    });
    // 179° → −179° sweeps +2°, not −358°.
    expect(rotateBox(start, at(179), at(-179))).toBe(2);
    expect(rotateBox(start, at(-179), at(179))).toBe(-2);
  });

  it('returns the start rotation unchanged for a press that never moved', () => {
    const start = box({ rotation: 12.345 });
    const pivot = boxPivot(start);
    const pointer = { x: pivot.x + 80, y: pivot.y - 40 };
    expect(rotateBox(start, pointer, { ...pointer })).toBe(start.rotation); // toBe: exact
    const barely = { x: pointer.x + 0.01, y: pointer.y };
    expect(rotateBox(start, pointer, barely)).toBe(start.rotation);
  });
});
