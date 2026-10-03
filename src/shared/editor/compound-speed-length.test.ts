/**
 * A restored child's LENGTH, re-timed to the length it rendered at.
 *
 * `planFlatten` composes `frameScale`/`frameOffset` for PLACEMENT, so a
 * restored child lands in the right place. Its LENGTH was still the nested
 * `durationFrames`, which no nest map has anything to do with: a child that
 * rendered `L / speed` parent frames came back `L` long — correctly placed and
 * stretched (or crushed, at `speed < 1`). A flatten is supposed to be visually
 * inert, and measured end to end it was not: `resolveRenderTimeline` before and
 * after a flatten of the same project agreed on every START and on no LENGTH.
 *
 * THE ORACLE IS THE RENDER PATH. A correct length is candidate B —
 * `round(scale * (s + L) + off) - round(scale * s + off)`, structurally the
 * `renderEnd - renderStart` that `emitLeaf` computes — and this file's first
 * test is the whole speed × start × length matrix measured against
 * `resolveRenderTimeline`, not against a formula restated here. Candidate A
 * (`round(scale * L)`) is a span pushed through the scale once instead of two
 * endpoints through the offset, and the matrix rejects it: it disagrees with the
 * render path on 32 of the 382 cells.
 *
 * SCOPE IS DEPTH-1 LEAVES, and the line is structural rather than a depth
 * counter. Everything the nest map carries to render space except a COMPOUND is
 * a leaf, and a compound carries a further map of its own; its `inPoint`/
 * `outPoint` are frames of ITS nested timeline while its length is frames of
 * this one, and the model cannot hold both unless every level runs at `speed: 1`.
 * Re-timing it satisfies `durationFrames === outPoint - inPoint` only by
 * shrinking its own window and cropping the inner nest — measured at 50% of the
 * nested content at `speed: 2` and 75% at `speed: 4`, with the deepest leaf
 * ceasing to render at all at 4x. So a restored compound is left exactly as it
 * is, the branch below is where depth 2 will be carried, and the V1 shape (the
 * length-only repair that keeps the window) is pinned here as the thing the
 * window guard catches.
 *
 * The `outPoint` factor is the child's OWN speed, not 1: it is what turns a
 * parent-frame length back into source frames, and `outPoint = inPoint + B` is
 * wrong for a sped-up child in both directions (compound 2x / child 2x, and
 * compound 4x / child 0.5).
 */

import { describe, expect, it } from 'vitest';
import { EditorController } from './controller';
import { planFlatten, planNest, resolveRenderTimeline, validateCompoundGraph } from './compound';
import { createEmptyProject, type Clip, type Project, type Timeline } from '../types/project';
import { effectiveSpeed } from '../media/source-time';

const TRACK_ID = 'v1';

function tracks(): Timeline['tracks'] {
  return [{ id: TRACK_ID, name: 'V1', type: 'video', locked: false, visible: true, syncLocked: true, order: 0 }];
}

function mediaClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'clip',
    assetId: 'asset',
    type: 'video',
    trackId: TRACK_ID,
    startFrame: 0,
    durationFrames: 60,
    inPoint: 0,
    outPoint: 60,
    x: 0, y: 0, width: 1920, height: 1080, rotation: 0,
    scaleX: 1, scaleY: 1, opacity: 1, anchorX: 0, anchorY: 0,
    volume: 1, muted: false,
    ...overrides,
  } as Clip;
}

/** The same window the placement matrix uses: a head that is NOT nested frame 0. */
const WINDOW_START = 24;
/** Wide enough that the compound's own crop is not the binding constraint at k >= 0.5. */
const WINDOW_SPAN = 1200;
/** The compound's `startFrame` in PARENT frames. */
const COMPOUND_START = 30;

/**
 * A depth-1 compound running at `speed`, holding one child of `nestedLen`
 * nested frames at `nestedStart`. Built directly rather than through `planNest`
 * so `startFrame`/`inPoint`/`outPoint` are exact and the matrix is reproducible.
 */
function spedUpNest(speed: number, nestedStart: number, nestedLen: number, childSpeed?: number): Project {
  const base = createEmptyProject('nested length');
  const compound = mediaClip({
    id: 'outer',
    type: 'compound',
    assetId: '__compound__',
    startFrame: COMPOUND_START,
    durationFrames: WINDOW_SPAN,
    inPoint: WINDOW_START,
    outPoint: WINDOW_START + WINDOW_SPAN,
    compoundTimelineId: 'leaf',
    speed,
  });
  const child = mediaClip({
    id: 'c1',
    startFrame: nestedStart,
    durationFrames: nestedLen,
    inPoint: 0,
    outPoint: childSpeed ? nestedLen * childSpeed : nestedLen,
    ...(childSpeed ? { speed: childSpeed } : {}),
  });
  return {
    ...base,
    timeline: { ...base.timeline, tracks: tracks(), clips: [compound] },
    timelines: {
      leaf: { tracks: tracks(), clips: [child], playheadFrame: 0, name: 'Leaf' },
    },
  };
}

/** A depth-2 nest: the outer compound is sped up and holds an inner COMPOUND. */
function depth2Nest(speed: number, innerStart: number, innerLen: number): Project {
  const base = createEmptyProject('depth 2');
  return {
    ...base,
    timeline: {
      ...base.timeline,
      tracks: tracks(),
      clips: [mediaClip({
        id: 'outer',
        type: 'compound',
        assetId: '__compound__',
        startFrame: COMPOUND_START,
        durationFrames: WINDOW_SPAN,
        inPoint: WINDOW_START,
        outPoint: WINDOW_START + WINDOW_SPAN,
        compoundTimelineId: 'level-0',
        speed,
      })],
    },
    timelines: {
      'level-0': {
        tracks: tracks(),
        playheadFrame: 0,
        name: 'Level 0',
        clips: [mediaClip({
          id: 'inner',
          type: 'compound',
          assetId: '__compound__',
          startFrame: innerStart,
          durationFrames: innerLen,
          inPoint: 0,
          outPoint: innerLen,
          compoundTimelineId: 'leaf',
        })],
      },
      leaf: {
        tracks: tracks(),
        playheadFrame: 0,
        name: 'Leaf',
        clips: [mediaClip({
          id: 'c1',
          startFrame: innerStart,
          durationFrames: innerLen,
          inPoint: 0,
          outPoint: innerLen,
        })],
      },
    },
  };
}

interface Window { startFrame: number; durationFrames: number; inPoint: number; outPoint: number }

function renderedWindow(project: Project, id = 'c1'): Window | null {
  const clip = resolveRenderTimeline(project).clips.find((c) => c.id === id);
  return clip
    ? { startFrame: clip.startFrame, durationFrames: clip.durationFrames, inPoint: clip.inPoint, outPoint: clip.outPoint }
    : null;
}

function restoredClip(project: Project, id = 'c1'): Clip {
  const clip = project.timeline.clips.find((c) => c.id === id);
  if (!clip) throw new Error(`${id} was not restored onto the main timeline`);
  return clip;
}

// The matrix. `SPEEDS` is the placement matrix's set plus the unit control that
// the placement matrix left out because it collapses to the old additive sum.
const SPEEDS = [0.5, 0.75, 1, 1.25, 2, 4];
const STARTS = [24, 25, 31, 40, 64];
const LENGTHS = [1, 2, 3, 4, 5, 7, 12, 24, 30, 48, 90, 120, 216];

interface Cell {
  speed: number;
  start: number;
  length: number;
  rendered: Window;
  restored: Clip;
}

/**
 * Every cell of the matrix whose child the compound's window actually shows, so
 * the render path has an answer to compare against. A child the window crops
 * away is not measurable (the render path emits nothing for it), and a child
 * whose mapped span rounds to zero parent frames is emitted as nothing by
 * `emitLeaf`'s own `emittedDuration <= 0` guard.
 */
function measurableCells(childSpeed?: number): { cells: Cell[]; dropped: number; cropped: number } {
  const cells: Cell[] = [];
  let dropped = 0;
  let cropped = 0;
  for (const speed of SPEEDS) {
    for (const start of STARTS) {
      for (const length of LENGTHS) {
        const project = spedUpNest(speed, start, length, childSpeed);
        const visibleNestedEnd = WINDOW_START + WINDOW_SPAN * speed;
        if (start + length > visibleNestedEnd) { cropped += 1; continue; }
        const rendered = renderedWindow(project);
        if (rendered === null) { dropped += 1; continue; }
        cells.push({
          speed,
          start,
          length,
          rendered,
          restored: restoredClip(planFlatten(project, 'outer').project),
        });
      }
    }
  }
  return { cells, dropped, cropped };
}

describe('a restored child re-times to the length it rendered at', () => {
  it('matches the render path in every cell of the matrix, with the matrix itself pinned', () => {
    const { cells, dropped, cropped } = measurableCells();

    // The measurement, not a sample: if the fixture drifts and the matrix
    // shrinks, these fail before the comparisons mean anything.
    expect(cells.length).toBe(382);
    expect(dropped).toBe(8);
    expect(cropped).toBe(0);
    const alreadyCorrect = cells.filter((cell) => cell.restored.durationFrames === cell.length);
    expect(alreadyCorrect).toHaveLength(76);

    for (const cell of cells) {
      const where = `speed ${cell.speed}, nested start ${cell.start}, length ${cell.length}`;
      expect(cell.restored.durationFrames, `${where}: length`).toBe(cell.rendered.durationFrames);
      expect(cell.restored.inPoint, `${where}: inPoint`).toBe(cell.rendered.inPoint);
      expect(cell.restored.outPoint, `${where}: outPoint`).toBe(cell.rendered.outPoint);
    }
  });

  it('moves no start: the placement fix this re-times alongside is untouched', () => {
    const { cells } = measurableCells();
    expect(cells).toHaveLength(382);
    for (const cell of cells) {
      expect(
        cell.restored.startFrame,
        `speed ${cell.speed}, nested start ${cell.start}, length ${cell.length}: start moved`,
      ).toBe(cell.rendered.startFrame);
    }
  });

  it('leaves an already-correct cell exactly as it was, byte for byte', () => {
    // The 76 zeros are the oracle for "unchanged where it was already right".
    // At `speed: 1` the map is the identity, so every child must come back with
    // the numbers it went in with.
    const unit = SPEEDS.length * STARTS.length * LENGTHS.length;
    const unitSpeed = measurableCells().cells.filter((cell) => cell.speed === 1);
    expect(unitSpeed).toHaveLength(unit / SPEEDS.length);
    for (const cell of unitSpeed) {
      const where = `nested start ${cell.start}, length ${cell.length}`;
      expect(cell.restored.durationFrames, `${where}: durationFrames moved at speed 1`).toBe(cell.length);
      expect(cell.restored.outPoint, `${where}: outPoint moved at speed 1`).toBe(cell.length);
      expect(cell.restored.inPoint, `${where}: inPoint moved at speed 1`).toBe(0);
    }
  });

  it('carries the child’s OWN speed into outPoint, not 1', () => {
    // The two cells the measurement rejected for `outPoint = inPoint + B`.
    for (const [compoundSpeed, childSpeed, length] of [[2, 2, 120], [4, 0.5, 120]] as const) {
      const project = spedUpNest(compoundSpeed, 40, length, childSpeed);
      const rendered = renderedWindow(project)!;
      const restored = restoredClip(planFlatten(project, 'outer').project);

      const where = `compound ${compoundSpeed}x, child ${childSpeed}x`;
      expect(restored.durationFrames, `${where}: length`).toBe(rendered.durationFrames);
      expect(restored.outPoint, `${where}: outPoint`).toBe(rendered.outPoint);
      // And the form: the child's own speed converts the parent-frame length
      // back into source frames. A 2x child at 60 parent frames plays 120.
      expect(restored.outPoint).toBe(restored.inPoint + Math.round(rendered.durationFrames * childSpeed));
      expect(restored.outPoint).not.toBe(restored.inPoint + rendered.durationFrames);
    }
  });

  it('is the render path’s arithmetic, not a span pushed through the scale once', () => {
    // Candidate A is the plausible wrong answer: round the LENGTH through the
    // scale instead of rounding both endpoints through the offset. It agrees
    // with the render path on most cells and disagrees on 32, so a matrix that
    // only sampled the agreeing cells would ship it.
    const { cells } = measurableCells();
    let candidateAWouldDiffer = 0;
    for (const cell of cells) {
      const scale = 1 / cell.speed;
      const offset = COMPOUND_START - WINDOW_START / cell.speed;
      const candidateA = Math.round(scale * cell.length);
      if (candidateA !== cell.rendered.durationFrames) candidateAWouldDiffer += 1;
      // The shipped form, recomputed the way `nestFrame` does it.
      const candidateB = Math.round(scale * (cell.start + cell.length) + offset)
        - Math.round(scale * cell.start + offset);
      expect(candidateB, `speed ${cell.speed}, start ${cell.start}, length ${cell.length}`).toBe(cell.rendered.durationFrames);
    }
    expect(candidateAWouldDiffer).toBe(32);
  });
});

describe('the trim window the re-timed clip carries', () => {
  it('keeps the source-time rule for every restored leaf of every cell', () => {
    // The repo's leaf rule, and what `emitLeaf` writes:
    // `outPoint - inPoint === round(durationFrames * speed)`. At `speed: 1` that
    // IS `durationFrames === outPoint - inPoint`, which is the compound
    // validation rule — the two coincide, so a fix that re-timed one and not the
    // other would pass at speed 1 and fail here.
    const { cells } = measurableCells();
    expect(cells).toHaveLength(382);
    for (const cell of cells) {
      const clip = cell.restored;
      expect(
        clip.outPoint - clip.inPoint,
        `speed ${cell.speed}, nested start ${cell.start}, length ${cell.length}`,
      ).toBe(Math.round(clip.durationFrames * effectiveSpeed(clip.speed)));
    }
  });

  it('keeps `durationFrames === outPoint - inPoint` on a speed-1 child, which is the compound rule', () => {
    for (const speed of SPEEDS) {
      const restored = restoredClip(planFlatten(spedUpNest(speed, 40, 90), 'outer').project);
      expect(
        restored.durationFrames,
        `speed ${speed}: a speed-1 child must satisfy the compound window rule too`,
      ).toBe(restored.outPoint - restored.inPoint);
    }
  });
});

describe('a restored COMPOUND child is left exactly as today', () => {
  // The scope boundary, pinned so it cannot move silently. Flattening an outer
  // sped-up nest restores an inner compound, and that one keeps its nested
  // `durationFrames` and its nested window.
  const INNER_START = 64;
  const INNER_LEN = 216;

  it('keeps the inner compound’s length and window, and only moves its start', () => {
    for (const speed of [0.5, 2, 4]) {
      const flat = planFlatten(depth2Nest(speed, INNER_START, INNER_LEN), 'outer').project;
      const inner = restoredClip(flat, 'inner');

      expect(inner.type, `speed ${speed}: the inner clip must still be a compound`).toBe('compound');
      expect(inner.durationFrames, `speed ${speed}: a restored compound was re-timed`).toBe(INNER_LEN);
      expect(inner.inPoint, `speed ${speed}: inPoint moved`).toBe(0);
      expect(inner.outPoint, `speed ${speed}: outPoint moved`).toBe(INNER_LEN);
      // Its start IS mapped — placement is depth-independent.
      expect(inner.startFrame, `speed ${speed}: the restored compound's start`).toBe(
        Math.round(INNER_START / speed + (COMPOUND_START - WINDOW_START / speed)),
      );
      // The window rule a compound is validated by, still satisfied.
      expect(inner.durationFrames, `speed ${speed}: compound window rule`).toBe(inner.outPoint - inner.inPoint);
      expect(validateCompoundGraph(flat), `speed ${speed}: graph`).toEqual([]);
    }
  });

  it('still flattens again, and the inner nest still renders', () => {
    for (const speed of [2, 4]) {
      const flat = planFlatten(depth2Nest(speed, INNER_START, INNER_LEN), 'outer').project;
      expect(() => planFlatten(flat, 'inner'), `speed ${speed}: second flatten refused`).not.toThrow();
      const leaf = renderedWindow(flat, 'c1');
      expect(leaf, `speed ${speed}: the deepest leaf must still render`).not.toBeNull();
    }
  });

  it('V1, the length-only repair, is what the window guard catches — and it is not what ships', () => {
    // The shape a careless re-timing takes: re-time the length, leave the
    // window. It satisfies nothing, and the guard is what says so — the
    // compound expands to nothing (its content silently leaves preview and
    // export) and the next flatten refuses it outright. Pinned so the reason
    // depth 2 is excluded stays a measured fact rather than a preference.
    const project = depth2Nest(2, INNER_START, INNER_LEN);
    const scale = 1 / 2;
    const offset = COMPOUND_START - WINDOW_START / 2;
    const v1Length = Math.round(scale * (INNER_START + INNER_LEN) + offset)
      - Math.round(scale * INNER_START + offset);
    const flat = planFlatten(project, 'outer').project;
    const v1: Project = {
      ...flat,
      timeline: {
        ...flat.timeline,
        clips: flat.timeline.clips.map((clip) => (
          clip.id === 'inner' ? { ...clip, durationFrames: v1Length } : clip
        )),
      },
    };

    const v1Inner = restoredClip(v1, 'inner');
    expect(v1Inner.durationFrames, 'the V1 fixture must really be length-only').toBe(v1Length);
    expect(v1Inner.durationFrames).not.toBe(v1Inner.outPoint - v1Inner.inPoint);
    // The two consequences that make it unusable.
    expect(renderedWindow(v1, 'c1'), 'the inner nest must vanish from the render').toBeNull();
    expect(() => planFlatten(v1, 'inner')).toThrow(/invalid nested window/);
    // And the shape that ships is not V1: it satisfies the same rule.
    const shipped = restoredClip(flat, 'inner');
    expect(shipped.durationFrames).toBe(shipped.outPoint - shipped.inPoint);
  });
});

describe('the flatten stays one undoable step', () => {
  it('undoes in exactly one command, at every speed, leaf and compound child alike', () => {
    for (const speed of SPEEDS) {
      const controller = new EditorController(spedUpNest(speed, 40, 120));
      const before = controller.serialize();

      const receipt = controller.flattenCompound('outer');
      expect(receipt.restoredClipIds, `speed ${speed}: receipt`).toEqual(['c1']);
      expect(controller.serialize(), `speed ${speed}: flatten changed nothing`).not.toBe(before);

      let steps = 0;
      while (controller.canUndo() && steps < 10) {
        controller.undo();
        steps += 1;
        if (controller.serialize() === before) break;
      }
      expect(steps, `speed ${speed}: undo arity`).toBe(1);
      expect(controller.canUndo(), `speed ${speed}: history left over`).toBe(false);
    }
  });

  it('undoes a depth-2 flatten in one command too, leaving the restored compound as it was', () => {
    const project = depth2Nest(2, 64, 216);
    const controller = new EditorController(project);
    const before = controller.serialize();
    controller.flattenCompound('outer');
    const after = controller.getProject().timeline.clips.find((c) => c.id === 'inner')!;
    expect(controller.undo()).toBe(true);
    expect(controller.serialize()).toBe(before);
    expect(controller.canUndo()).toBe(false);
    expect(after.durationFrames).toBe(216);
  });
});

describe('the re-timing does not disturb the nest contract around it', () => {
  it('still restores the full nested content, not just the referenced window', () => {
    // `planFlatten` restores content the compound's window never showed. A child
    // outside the window has no rendered length to reproduce, and the contract
    // that it is restored at all — with no trim taken off the front — stands.
    const project = spedUpNest(2, 40, 90);
    const nested = project.timelines!.leaf!.clips[0]!;
    const restored = restoredClip(planFlatten(project, 'outer').project);
    const scale = 1 / 2;
    const offset = COMPOUND_START - WINDOW_START / 2;

    expect(restored.inPoint, 'the head cut must stay zero, so inPoint is the child’s own').toBe(nested.inPoint);
    expect(restored.startFrame, 'the head goes through the same map as the span').toBe(
      Math.round(scale * nested.startFrame + offset),
    );
    expect(restored.durationFrames, 'the span is the two mapped endpoints').toBe(
      Math.round(scale * (nested.startFrame + nested.durationFrames) + offset)
      - Math.round(scale * nested.startFrame + offset),
    );
    // A speed-1 child claims exactly the source it plays, and not one frame more.
    expect(restored.outPoint - restored.inPoint).toBe(restored.durationFrames);
  });

  it('leaves keyframe rebasing on the same scale', () => {
    const project = spedUpNest(2, 40, 90);
    project.timelines!.leaf!.clips[0]!.motionX = [
      { frame: 40, value: 0 },
      { frame: 130, value: 10 },
    ];
    const restored = restoredClip(planFlatten(project, 'outer').project);
    const offset = COMPOUND_START - WINDOW_START / 2;
    expect(restored.motionX?.map((point) => point.frame)).toEqual([
      Math.round(40 / 2) + offset,
      Math.round(130 / 2) + offset,
    ]);
  });

  it('a nest of one clip still flattens to a leaf, and a nest of a nest to a compound', () => {
    // The measured basis for the scope line: depth 1 restores leaves, so the
    // re-timing applies; flattening an outer nest restores a compound, so it
    // does not.
    const seeded: Project = {
      ...createEmptyProject('nest'),
      timeline: {
        ...createEmptyProject().timeline,
        tracks: tracks(),
        clips: [mediaClip({ id: 'a', startFrame: 0, durationFrames: 240, inPoint: 0, outPoint: 240 })],
      },
    };
    const once = planNest(seeded, ['a']).project;
    const compound = once.timeline.clips[0]!;
    const innerTypes = once.timelines![compound.compoundTimelineId!]!.clips.map((clip) => clip.type);
    expect(innerTypes, 'depth 1 flattens to leaves').toEqual(['video']);

    const twice = planNest(once, [compound.id]).project;
    const outer = twice.timeline.clips[0]!;
    const levelTypes = twice.timelines![outer.compoundTimelineId!]!.clips.map((clip) => clip.type);
    expect(levelTypes, 'flattening the outer restores a compound').toEqual(['compound']);
  });
});
