/**
 * Speed-aware window math for nested timelines (shared/editor/compound.ts).
 *
 * `resolveRenderTimeline` expands a compound into ordinary render clips, and
 * every place it converts a timeline frame into a source frame is a second
 * copy of the shared source-time model
 * (`shared/media/source-time.ts`):
 *
 *   sourceOffset = clip.inPoint + (timelineFrame - clip.startFrame) * speed
 *
 * The compound copy dropped the `speed` term, which is the same omission
 * `rippleDeleteRanges`/`clearTrackSpans`/`planClipSplit`/`compactTake` had on
 * the main timeline before they were routed through the controller's
 * `sourceWindowForSlice`. The window a nested clip is trimmed against is the
 * one preview and export read, so a sped-up clip inside a nest claimed a
 * fraction of the source it actually plays.
 *
 * REACHABILITY (established before the fix, not assumed):
 *
 * - A CHILD clip can carry `speed !== 1`. `EditorController.setClipSpeed`
 *   refuses `audio`, `title`, and `compound` targets, and every editing op
 *   routes through `scopedTimeline()` — the OPEN nested scope. So "open the
 *   nest, set 2x" is a plain two-step user path, and it needs no degenerate
 *   state.
 * - A COMPOUND clip can carry `speed !== 1` too, but no longer through
 *   `setClipSpeed`: it refuses the type, and `setClipOpacityTrack` always did
 *   (controller.speed-compound.test.ts). Such a compound can only arrive from
 *   a project saved while the setter accepted one. `trimClip` rewrites
 *   `durationFrames = outPoint - inPoint` for any clip type, so a subsequent
 *   trim re-admits the `durationFrames === outPoint - inPoint` guard while
 *   leaving `speed` in place. Both states are pinned below: the rejection is
 *   CURRENT CONTRACT, and the speed term is still honored in the state that
 *   passes it.
 *
 * THE INVERSE DIRECTION, and why it is a different fix (this file's second
 * half). Everything above maps a frame DOWN a level. Mapping one back UP is
 * the other half of the same model, and it is where an additive `frameShift`
 * failed: the timeline→nested map is `n = inPoint + (t - startFrame) * speed`,
 * so the way back is `t = startFrame + (n - inPoint) / speed` — a SCALED
 * offset. Composing two levels multiplies the scales and re-anchors the
 * offsets, and a running sum of displacements can only ever express the affine
 * with slope 1. So `NestContext` carries the pair (`frameScale`/`frameOffset`),
 * and the sum it replaced is the exact special case where every compound on the
 * path runs at `speed: 1`.
 *
 * REACHABILITY of the second half was established before the fix, not assumed:
 * `setClipSpeed` is the only writer of `speed` in the repo and it refuses a
 * compound (and a linked group holding one), and the FCPXML importer refuses to
 * import a compound timeMap. So the state is a legacy project file plus one
 * window rewrite — `trimClip` sets `durationFrames = outPoint - inPoint` for
 * any clip type, which re-admits a sped-up compound into a window-valid state
 * with its `speed` intact. Both halves of that are pinned below, and the
 * resolver then has to place such a clip correctly, because a file the user can
 * open must not render its nest displaced.
 *
 * Differential matrix: at `speed: 1` this must be byte-identical to the
 * pre-fix arithmetic, checked against a verbatim transcription of it across
 * compound window shapes, child layouts, nesting depths and frame rates. The
 * frame rates are in the matrix deliberately: the TIMEBASE RULE makes nested
 * frame math fps-invariant, and the matrix proves that rather than assuming it.
 */

import { describe, it, expect } from 'vitest';
import { EditorController } from './controller';
import {
  MAX_COMPOUND_DEPTH,
  planFlatten,
  planNest,
  resolveRenderTimeline,
  validateCompoundGraph,
} from './compound';
import { createEmptyProject } from '../types/project';
import { effectiveSpeed, sourceSecondsForTimelineFrame } from '../media/source-time';
import type { Clip, Frame, Project, Timeline, Track } from '../types/project';

const TRACK_ID = 'v1';

function tracks(): Track[] {
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
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    opacity: 1,
    anchorX: 0,
    anchorY: 0,
    volume: 1,
    muted: false,
    ...overrides,
  };
}

/** A compound clip whose window satisfies `durationFrames === outPoint - inPoint`. */
function compoundClip(id: string, timelineId: string, window: { inPoint: Frame; outPoint: Frame; startFrame: Frame }): Clip {
  return mediaClip({
    id,
    type: 'compound',
    assetId: '__compound__',
    startFrame: window.startFrame,
    durationFrames: window.outPoint - window.inPoint,
    inPoint: window.inPoint,
    outPoint: window.outPoint,
    compoundTimelineId: timelineId,
  });
}

/** A minimal valid compound window. */
function window40(): { inPoint: Frame; outPoint: Frame; startFrame: Frame } {
  return { inPoint: 0, outPoint: 40, startFrame: 0 };
}

// ─── The pre-fix arithmetic, transcribed verbatim ───────────────────────────

/**
 * The window/fade math of the pre-fix `expandTimeline`/`emitLeaf`, copied
 * unchanged: every `clip.inPoint + (x - clip.startFrame)` with no `speed` term,
 * `outPoint = inPoint + duration` with no term either, and unconverted gate
 * lengths. This is the `speed: 1` oracle, and the object the sped-up
 * differential groups compare against to prove the term is load-bearing.
 *
 * Scope: window and fade fields only. Transform composition and keyframe
 * rebasing are untouched by the fix and stay covered by compound.test.ts.
 */
interface LegacyGate { start: number; length: number }

interface LegacyCtx {
  namespace: string;
  windowStart: number;
  windowEnd: number;
  frameShift: number;
  fadeIns: LegacyGate[];
  fadeOuts: LegacyGate[];
}

interface LegacyEmitted {
  id: string;
  startFrame: number;
  durationFrames: number;
  inPoint: number;
  outPoint: number;
  speed: number | undefined;
  fadeInFrames: number | undefined;
  fadeOutFrames: number | undefined;
}

function legacyRoot(): LegacyCtx {
  return {
    namespace: '',
    windowStart: Number.NEGATIVE_INFINITY,
    windowEnd: Number.POSITIVE_INFINITY,
    frameShift: 0,
    fadeIns: [],
    fadeOuts: [],
  };
}

function legacyExpand(
  nested: Record<string, Timeline>,
  timeline: Timeline,
  ctx: LegacyCtx,
  depth: number,
  seen: ReadonlySet<string>,
  out: LegacyEmitted[],
): void {
  for (const clip of timeline.clips) {
    if (clip.type !== 'compound') {
      legacyEmitLeaf(clip, ctx, out);
      continue;
    }
    const ref = typeof clip.compoundTimelineId === 'string' ? clip.compoundTimelineId : undefined;
    const inner = ref === undefined ? undefined : nested[ref];
    if (
      !inner
      || depth >= MAX_COMPOUND_DEPTH
      || (ref !== undefined && seen.has(ref))
      || !Number.isFinite(clip.inPoint) || !Number.isFinite(clip.outPoint)
      || clip.inPoint < 0 || clip.outPoint <= clip.inPoint
      || clip.durationFrames !== clip.outPoint - clip.inPoint
    ) {
      continue;
    }

    // Legacy: no `speed` term on either end of the child window.
    const windowStart = Math.max(clip.startFrame, ctx.windowStart);
    const windowEnd = Math.min(clip.startFrame + clip.durationFrames, ctx.windowEnd);
    if (windowEnd <= windowStart) continue;
    const childWindowStart = clip.inPoint + (windowStart - clip.startFrame);
    const childWindowEnd = clip.inPoint + (windowEnd - clip.startFrame);

    const child: LegacyCtx = {
      namespace: `${ctx.namespace}${clip.id}/`,
      windowStart: childWindowStart,
      windowEnd: childWindowEnd,
      frameShift: ctx.frameShift + clip.startFrame - clip.inPoint,
      fadeIns: [
        ...ctx.fadeIns.map((gate) => ({
          start: clip.inPoint + (gate.start - clip.startFrame),
          length: gate.length,
        })),
        ...((clip.fadeInFrames ?? 0) > 0
          ? [{ start: clip.inPoint, length: clip.fadeInFrames as number }]
          : []),
      ],
      fadeOuts: [
        ...ctx.fadeOuts.map((gate) => ({
          start: clip.inPoint + (gate.start - clip.startFrame),
          length: gate.length,
        })),
        ...((clip.fadeOutFrames ?? 0) > 0
          ? [{
            start: clip.inPoint + clip.durationFrames - (clip.fadeOutFrames as number),
            length: clip.fadeOutFrames as number,
          }]
          : []),
      ],
    };
    const childSeen = new Set(seen);
    childSeen.add(ref as string);
    legacyExpand(nested, inner, child, depth + 1, childSeen, out);
  }
}

function legacyEmitLeaf(clip: Clip, ctx: LegacyCtx, out: LegacyEmitted[]): void {
  const atRoot = ctx.namespace === '';
  const overlapStart = Math.max(clip.startFrame, ctx.windowStart);
  const overlapEnd = Math.min(clip.startFrame + clip.durationFrames, ctx.windowEnd);
  if (overlapEnd <= overlapStart) return;

  // Legacy: head cut and window span with no `speed` term.
  const headCut = overlapStart - clip.startFrame;
  const emittedDuration = overlapEnd - overlapStart;
  const emittedInPoint = clip.inPoint + headCut;
  const emitted: LegacyEmitted = {
    id: clip.id,
    startFrame: overlapStart + (atRoot ? 0 : ctx.frameShift),
    durationFrames: emittedDuration,
    inPoint: emittedInPoint,
    outPoint: emittedInPoint + emittedDuration,
    speed: clip.speed,
    fadeInFrames: clip.fadeInFrames,
    fadeOutFrames: clip.fadeOutFrames,
  };

  if (!atRoot) {
    let fadeIn = emitted.fadeInFrames ?? 0;
    for (const gate of ctx.fadeIns) {
      const remaining = gate.length - (overlapStart - gate.start);
      if (remaining > 0) fadeIn = Math.max(fadeIn, remaining);
    }
    let fadeOut = emitted.fadeOutFrames ?? 0;
    for (const gate of ctx.fadeOuts) {
      const remaining = gate.length - (gate.start + gate.length - overlapEnd);
      if (remaining > 0) fadeOut = Math.max(fadeOut, remaining);
    }
    fadeIn = Math.min(Math.max(fadeIn, 0), emittedDuration);
    fadeOut = Math.min(Math.max(fadeOut, 0), emittedDuration);
    emitted.fadeInFrames = fadeIn > 0 ? fadeIn : undefined;
    emitted.fadeOutFrames = fadeOut > 0 ? fadeOut : undefined;
  }
  out.push(emitted);
}

/** Run the legacy oracle over a project. */
function legacyWindows(project: Project): LegacyEmitted[] {
  const out: LegacyEmitted[] = [];
  legacyExpand(project.timelines ?? {}, project.timeline, legacyRoot(), 0, new Set(), out);
  return out.sort((left, right) => left.startFrame - right.startFrame || (left.id < right.id ? -1 : 1));
}

/** The same fields, read off the real resolver. */
function actualWindows(project: Project): LegacyEmitted[] {
  return resolveRenderTimeline(project).clips
    .map((clip) => ({
      id: clip.id,
      startFrame: clip.startFrame,
      durationFrames: clip.durationFrames,
      inPoint: clip.inPoint,
      outPoint: clip.outPoint,
      speed: clip.speed,
      fadeInFrames: clip.fadeInFrames,
      fadeOutFrames: clip.fadeOutFrames,
    }))
    .sort((left, right) => left.startFrame - right.startFrame || (left.id < right.id ? -1 : 1));
}

function windowProject(fps: number, clips: Clip[]): Project {
  const base = createEmptyProject('nested speed');
  return {
    ...base,
    settings: { ...base.settings, fps },
    timeline: { ...base.timeline, tracks: tracks(), clips },
  };
}

// ─── The matrix ─────────────────────────────────────────────────────────────

interface CompoundWindowShape {
  name: string;
  inPoint: Frame;
  outPoint: Frame;
  startFrame: Frame;
}

/** Window shapes, all satisfying `durationFrames === outPoint - inPoint`. */
const WINDOW_SHAPES: CompoundWindowShape[] = [
  { name: 'full', inPoint: 0, outPoint: 200, startFrame: 0 },
  { name: 'head-trimmed', inPoint: 40, outPoint: 200, startFrame: 40 },
  { name: 'tail-trimmed', inPoint: 0, outPoint: 120, startFrame: 0 },
  { name: 'mid-window', inPoint: 50, outPoint: 150, startFrame: 50 },
  { name: 'later-on-timeline', inPoint: 20, outPoint: 180, startFrame: 300 },
];

/** Child layouts in nested-timeline frames. */
const CHILD_LAYOUTS: Array<{ name: string; clips: Clip[] }> = [
  { name: 'single', clips: [mediaClip({ id: 'c1', durationFrames: 120, inPoint: 0, outPoint: 120 })] },
  {
    name: 'leading-gap',
    clips: [mediaClip({ id: 'c1', startFrame: 30, durationFrames: 60, inPoint: 10, outPoint: 70 })],
  },
  {
    name: 'overruns-window',
    clips: [mediaClip({ id: 'c1', durationFrames: 200, inPoint: 0, outPoint: 200 })],
  },
  {
    name: 'two-with-fades',
    clips: [
      mediaClip({ id: 'c1', durationFrames: 60, inPoint: 0, outPoint: 60 }),
      mediaClip({
        id: 'c2',
        startFrame: 60,
        durationFrames: 90,
        inPoint: 30,
        outPoint: 120,
        fadeInFrames: 12,
        fadeOutFrames: 8,
      }),
    ],
  },
];

const FRAME_RATES = [24, 25, 30, 60];

/**
 * Attach `speed` the way every writer in the repo does: the speed plus an
 * `outPoint` scaled from the duration, so the fixture stays self-consistent
 * with the speed command. `undefined` means no `speed` key at all.
 */
function withSpeed(clip: Clip, speed: number | undefined): Clip {
  if (speed === undefined) return { ...clip };
  return { ...clip, speed, outPoint: clip.inPoint + Math.round(clip.durationFrames * speed) };
}

/**
 * A COMPOUND carrying `speed` with its window left self-consistent, which is
 * the state a project saved while `setClipSpeed` accepted compounds has after
 * one `trimClip` (`durationFrames = outPoint - inPoint`, speed untouched). NOT
 * `withSpeed`: scaling a compound's outPoint is what breaks the window guard
 * and makes the compound resolve to nothing.
 */
function withCompoundSpeed(clip: Clip, speed: number | undefined): Clip {
  return speed === undefined ? { ...clip } : { ...clip, speed };
}

/** Every combination of `depth` window shapes, outermost first. */
function* windowCombinations(depth: number): Generator<CompoundWindowShape[]> {
  const picks = new Array<number>(depth).fill(0);
  for (;;) {
    yield picks.map((pick) => WINDOW_SHAPES[pick]!);
    let slot = depth - 1;
    while (slot >= 0) {
      picks[slot] += 1;
      if (picks[slot] < WINDOW_SHAPES.length) break;
      picks[slot] = 0;
      slot -= 1;
    }
    if (slot < 0) return;
  }
}

/**
 * A nest `depth` compounds deep whose innermost timeline holds `children`, one
 * window per level (`windows[0]` is the deepest compound's), and every
 * compound carrying `compoundSpeed`.
 */
function matrixProject(
  fps: number,
  depth: 1 | 2 | 3,
  children: Clip[],
  windows: CompoundWindowShape[],
  compoundSpeed: number | undefined = undefined,
): Project {
  const leafId = 'leaf';
  const nested: Record<string, Timeline> = {
    [leafId]: { tracks: tracks(), clips: children, playheadFrame: 0, name: 'Leaf' },
  };
  // Timeline `level-i` holds the compound that references `level-(i+1)`, and
  // the last one references the leaf, so `windows[i]` is that compound's.
  for (let level = 0; level <= depth - 2; level += 1) {
    const next = level === depth - 2 ? leafId : `level-${level + 1}`;
    nested[`level-${level}`] = {
      tracks: tracks(),
      clips: [withSpeed(compoundClip(`inner-clip-${level}`, next, windows[level]), compoundSpeed)],
      playheadFrame: 0,
      name: `Level ${level}`,
    };
  }
  return {
    ...windowProject(fps, [
      withSpeed(
        compoundClip('outer-clip', depth === 1 ? leafId : 'level-0', windows[depth - 1]),
        compoundSpeed,
      ),
    ]),
    timelines: nested,
  };
}

/** Every matrix case at the given child and compound speeds. */
function* matrixCases(
  childSpeed: number | undefined,
  compoundSpeed: number | undefined = undefined,
): Generator<{ label: string; project: Project }> {
  for (const fps of FRAME_RATES) {
    for (const depth of [1, 2, 3] as const) {
      for (const windows of windowCombinations(depth)) {
        for (const layout of CHILD_LAYOUTS) {
          yield {
            label: `fps=${fps} depth=${depth} windows=${windows.map((w) => w.name).join('/')} children=${layout.name}`,
            project: matrixProject(
              fps,
              depth,
              layout.clips.map((clip) => withSpeed(clip, childSpeed)),
              windows,
              compoundSpeed,
            ),
          };
        }
      }
    }
  }
}

describe('nested window math at speed 1 is byte-identical to the pre-fix arithmetic', () => {
  it('matches the verbatim legacy oracle across the full matrix (no `speed` key)', () => {
    let checked = 0;
    for (const { label, project } of matrixCases(undefined)) {
      expect(actualWindows(project), label).toEqual(legacyWindows(project));
      checked += 1;
    }
    // 4 fps x (5 + 25 + 125) window combinations x 4 child layouts.
    expect(checked).toBe(4 * (5 + 25 + 125) * 4);
  });

  it('matches it identically for an explicit `speed: 1`', () => {
    let checked = 0;
    for (const { label, project } of matrixCases(1)) {
      expect(actualWindows(project), label).toEqual(legacyWindows(project));
      checked += 1;
    }
    expect(checked).toBe(4 * (5 + 25 + 125) * 4);
  });

  it('matches it identically with an explicit `speed: 1` on every COMPOUND too', () => {
    // The scale the composition introduces is `1 / speed` per level, so a
    // nest whose compounds are all `speed: 1` has scale 1 at every depth and
    // the pair collapses to the additive shift. The legacy oracle never reads
    // a compound's `speed`, so this is byte-identity including the `speed` key
    // landing on the emitted clip unchanged.
    let checked = 0;
    for (const { label, project } of matrixCases(1, 1)) {
      expect(actualWindows(project), label).toEqual(legacyWindows(project));
      checked += 1;
    }
    expect(checked).toBe(4 * (5 + 25 + 125) * 4);
  });

  it('is frame-rate invariant: the same case resolves identically at 24/25/30/60', () => {
    for (const depth of [1, 2, 3] as const) {
      for (const windows of windowCombinations(depth)) {
        const children = CHILD_LAYOUTS[3].clips;
        const reference = actualWindows(matrixProject(24, depth, children, windows));
        for (const fps of [25, 30, 60]) {
          expect(
            actualWindows(matrixProject(fps, depth, children, windows)),
            `fps=${fps} depth=${depth} windows=${windows.map((w) => w.name).join('/')}`,
          ).toEqual(reference);
        }
      }
    }
  });
});

describe('a sped-up CHILD clip maps to the correct nested source window', () => {
  it('renders a 2x clip inside a nest against the source it actually plays', () => {
    // Main: one clip [0,120) nested into a compound. Open the nest, 2x the
    // child: setClipSpeed leaves the timeline duration alone and scales the
    // window, so the child is start 0, duration 120, in 0, out 240, speed 2.
    const controller = new EditorController(windowProject(30, [
      mediaClip({ id: 'a', durationFrames: 120, inPoint: 0, outPoint: 120 }),
    ]));
    const nest = controller.nestClips(['a']);
    controller.openNestedTimeline(nest.timelineId);
    expect(controller.setClipSpeed('a', 2)).toBe(true);
    const spedUp = controller.getClips()[0]!;
    expect(clipWindow(spedUp)).toEqual({ start: 0, dur: 120, in: 0, out: 240, speed: 2 });

    // Trim the COMPOUND's window to [60,120) so the child's head cut is 60
    // nested frames — the case where dropping `speed` moves the window.
    controller.navigateToScope(null);
    controller.trimClip(nest.compoundClipId, 60, 120);

    const rendered = resolveRenderTimeline(controller.getProject()).clips[0]!;
    // Worked numbers. headCut = overlapStart(60) - startFrame(0) = 60.
    //   inPoint  = inPoint(0) + round(60 * 2)            = 120
    //   outPoint = inPoint(120)  + round(60 * 2)         = 240
    // The pre-fix arithmetic produced 60 and 120: half the source, i.e. exactly
    // 1x worth of frames for a clip that plays 2x.
    expect(rendered.inPoint).toBe(120);
    expect(rendered.outPoint).toBe(240);
    expect(rendered.durationFrames).toBe(60);
    expect(rendered.speed).toBe(2);
    // The window is self-consistent with the speed the clip still carries:
    // outPoint - inPoint === round(durationFrames * effectiveSpeed(speed)).
    expect(rendered.outPoint - rendered.inPoint)
      .toBe(Math.round(rendered.durationFrames * effectiveSpeed(rendered.speed)));
    // And it agrees with the shared model read back through seconds.
    expect(sourceSecondsForTimelineFrame(rendered, rendered.startFrame, 30)).toBeCloseTo(4, 10);
  });

  it('renders an untrimmed 2x nest identically to the same nest flattened', () => {
    // With no trim the whole window is visible, so flattening is the oracle:
    // flatten does not touch a child's trim, only its position.
    const nested = planNest(windowProject(30, [
      mediaClip({ id: 'a', durationFrames: 120, inPoint: 0, outPoint: 120 }),
    ]), ['a']).project;
    const spedUp: Project = {
      ...nested,
      timelines: {
        ...nested.timelines!,
        [Object.keys(nested.timelines!)[0]!]: {
          ...nested.timelines![Object.keys(nested.timelines!)[0]!]!,
          clips: nested.timelines![Object.keys(nested.timelines!)[0]!]!.clips.map((clip) => ({
            ...clip,
            speed: 2,
            outPoint: clip.inPoint + Math.round(clip.durationFrames * 2),
          })),
        },
      },
    };
    const compoundId = spedUp.timeline.clips[0].id;
    const flat = planFlatten(spedUp, compoundId).project;
    expect(actualWindows(spedUp)).toEqual(actualWindows(flat));
    // The flattened child keeps the 2x window; the nested render must too.
    expect(actualWindows(spedUp)[0]).toMatchObject({ inPoint: 0, outPoint: 240, speed: 2 });
  });

  it('honors fractional speed and degrades garbage speed to normal', () => {
    const project = windowProject(30, [mediaClip({ id: 'a', durationFrames: 120, inPoint: 0, outPoint: 120 })]);
    const nested = planNest(project, ['a']).project;
    const leafId = Object.keys(nested.timelines!)[0]!;
    const at = (speed: number | undefined, outPoint: number): Project => ({
      ...nested,
      timelines: {
        ...nested.timelines!,
        [leafId]: {
          ...nested.timelines![leafId]!,
          clips: nested.timelines![leafId]!.clips.map((clip) => ({
            ...clip,
            ...(speed === undefined ? {} : { speed }),
            outPoint,
          })),
        },
      },
    });
    // 1.5x: outPoint = inPoint + round(120 * 1.5) = 180.
    expect(actualWindows(at(1.5, 180))[0]).toMatchObject({ inPoint: 0, outPoint: 180 });
    // Garbage (negative) speed resolves to 1 through the shared primitive, so
    // the window is the speed-1 window rather than a negative span.
    expect(actualWindows(at(-2, 120))[0]).toMatchObject({ inPoint: 0, outPoint: 120 });
  });
});

function clipWindow(clip: Clip): Record<string, unknown> {
  return {
    start: clip.startFrame,
    dur: clip.durationFrames,
    in: clip.inPoint,
    out: clip.outPoint,
    speed: clip.speed,
  };
}

describe('a sped-up COMPOUND clip: the guard is current contract, the term is honored past it', () => {
  it('an invalid nested window renders nothing and refuses to flatten', () => {
    const controller = new EditorController(windowProject(30, [
      mediaClip({ id: 'a', durationFrames: 60, inPoint: 0, outPoint: 60 }),
    ]));
    const nest = controller.nestClips(['a']);
    // The shape `setClipSpeed` used to write, built by hand: the speed is set
    // and outPoint is scaled from durationFrames, so the window no longer
    // describes the clip. The controller refuses a compound outright now
    // (controller.speed-compound.test.ts), so this state only arrives from a
    // project saved while that was true -- and the window guard still has to
    // answer for it.
    controller.applyClipProperties([nest.compoundClipId], 'Set speed to 2x', (draft) => {
      draft.speed = 2;
      draft.outPoint = draft.inPoint + Math.round(draft.durationFrames * 2);
      return true;
    });
    const compound = controller.getClips()[0]!;
    expect(compound.speed).toBe(2);
    expect(compound.durationFrames).not.toBe(compound.outPoint - compound.inPoint);
    // CURRENT CONTRACT, pinned: the compound is refused, not mis-rendered.
    expect(resolveRenderTimeline(controller.getProject()).clips).toEqual([]);
    expect(() => planFlatten(controller.getProject(), nest.compoundClipId))
      .toThrow(/invalid nested window/);
    // And the speed setter is no longer what can put a compound in this state.
    expect(() => controller.setClipSpeed(nest.compoundClipId, 2)).toThrow(/cannot be sped up/);
  });

  it('honors the term once the guard holds again (a trim re-admits it)', () => {
    // Depth 2: the inner compound carries 2x and the outer compound's trimmed
    // window crops into it, so the child window is where `speed` shows up.
    const controller = new EditorController(windowProject(30, [
      mediaClip({ id: 'a', durationFrames: 200, inPoint: 0, outPoint: 200 }),
    ]));
    const outer = controller.nestClips(['a']);
    controller.openNestedTimeline(outer.timelineId);
    const inner = controller.nestClips(['a']);
    // Speed written straight onto the inner compound (the one shape that can
    // carry it now that `setClipSpeed` refuses the type): 2x, outPoint scaled.
    controller.applyClipProperties([inner.compoundClipId], 'Set speed to 2x', (draft) => {
      draft.speed = 2;
      draft.outPoint = draft.inPoint + Math.round(draft.durationFrames * 2);
      return true;
    });
    // Guard now failing; trimClip rewrites durationFrames = outPoint - inPoint.
    controller.trimClip(inner.compoundClipId, 0, 400);
    controller.navigateToScope(null);
    controller.trimClip(outer.compoundClipId, 60, 200);

    const rendered = actualWindows(controller.getProject());
    // Outer window [60,200) over an inner compound at nested 0 spanning 400
    // source frames at 2x. Speed-aware: the visible nested window is
    // [0 + 60*2, 0 + 200*2) = [120, 400). Child 'a' occupies nested [0,200),
    // so the visible part is [120,200) — 80 nested frames.
    expect(rendered).toHaveLength(1);
    // Those 80 nested frames are 80/2 = 40 RENDER frames, because the inner
    // compound's 2x is what put them there. Composed by hand, level by level
    // (`t = startFrame + (n - inPoint) / speed`, then out through the parent):
    //   inner compound  S=0 I=0 k=2 : nested 120 -> inner-nest 60,
    //                                        nested 200 -> inner-nest 100
    //   outer compound  S=0 I=60 k=1: inner-nest 60  -> main 0,
    //                                          inner-nest 100 -> main 40
    // So the leaf renders main [0,40), and — the leaf being 1x — plays 40 of
    // its own source frames, from 60: its own start renders at main -60, so the
    // head cut is 60. The window stays the source-time model's window, now
    // measured over the render span the emitted clip actually occupies.
    expect(rendered[0]).toMatchObject({ startFrame: 0, durationFrames: 40, inPoint: 60, outPoint: 100 });
    // The pre-fix oracle reads the same project as the full [60,200), and it
    // never scaled: it emitted the leaf 140 frames long — the NESTED span — so
    // it ran 100 frames past the 40 the compound actually renders there, and
    // its window is that nested span's rather than the render span's. Its
    // start happens to agree here only because the sped-up level's inPoint is
    // 0, which is the one case where `inPoint` and `inPoint / speed` coincide.
    expect(legacyWindows(controller.getProject())[0])
      .toMatchObject({ startFrame: 0, durationFrames: 140, inPoint: 60, outPoint: 200 });
  });

  it('converts the compound\'s own fade ramps into nested frames with the same term', () => {
    // A gate's position AND its length are the same timeline->source
    // conversion applied to an endpoint and to a span, so a sped-up compound's
    // ramp covers twice as many nested frames. Only a sped-up COMPOUND's own
    // fades reach a nested leaf, so this is the only coverage for that path.
    //
    // Built by hand: `planNest` creates the compound with no fades of its own,
    // and the controller's fade setter is not what is under test here. Window
    // [0,100) of the compound's own timeline satisfies the guard
    // (100 === 100 - 0) while carrying speed 2.
    const compound: Clip = {
      ...compoundClip('outer', 'leaf', { inPoint: 0, outPoint: 100, startFrame: 0 }),
      speed: 2,
      fadeInFrames: 20,
      fadeOutFrames: 30,
    };
    const project: Project = {
      ...windowProject(30, [compound]),
      timelines: {
        leaf: { tracks: tracks(), clips: [mediaClip({ id: 'a', durationFrames: 200, inPoint: 0, outPoint: 200 })], playheadFrame: 0 },
      },
    };

    const rendered = actualWindows(project);
    // The compound's window is nested [0,100) of its timeline = [0,200) of the
    // nested one at 2x, so the leaf is visible whole — but it renders inside
    // the compound's own 100-frame footprint, so 200 nested frames become 100
    // render frames (scale 1/2), and the leaf is 1x, so it plays 100 of its own
    // source frames. The compound's ramps stay the lengths it was given: 40
    // nested frames of ramp is 20 render frames, 60 is 30.
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toMatchObject({ startFrame: 0, durationFrames: 100, inPoint: 0, outPoint: 100, fadeInFrames: 20, fadeOutFrames: 30 });
    // Legacy: the ramps stayed 20 and 30 nested frames long and were compared
    // against a nested-frame duration, so they read as 40 and 60 here — and
    // because the legacy child window also drops the term, it is [0,100)
    // rather than [0,200), so the leaf is cut in half as well.
    expect(legacyWindows(project)[0]).toMatchObject({
      durationFrames: 100,
      fadeInFrames: 20,
      fadeOutFrames: 30,
    });
  });
});

describe('depth and cycle rejection are unchanged', () => {
  it('refuses an over-deep chain and resolves it to nothing', () => {
    // A hand-built chain one level past the cap: main -> level-0 … level-8 ->
    // leaf, i.e. a compound-reference chain of MAX_COMPOUND_DEPTH + 2.
    const timelines: Record<string, Timeline> = {
      leaf: { tracks: tracks(), clips: [mediaClip({ id: 'leaf-clip', durationFrames: 40, inPoint: 0, outPoint: 40 })], playheadFrame: 0 },
    };
    for (let level = 0; level <= MAX_COMPOUND_DEPTH; level += 1) {
      const next = level === MAX_COMPOUND_DEPTH ? 'leaf' : `level-${level + 1}`;
      timelines[`level-${level}`] = {
        tracks: tracks(),
        clips: [compoundClip(`clip-${level}`, next, window40())],
        playheadFrame: 0,
      };
    }
    const project: Project = {
      ...windowProject(30, [compoundClip('root', 'level-0', window40())]),
      timelines,
    };
    expect(validateCompoundGraph(project).some((error) => error.includes('past the maximum'))).toBe(true);
    // Render never throws on an over-deep chain; it truncates.
    expect(() => resolveRenderTimeline(project)).not.toThrow();
  });

  it('resolves a cycle to nothing instead of recursing', () => {
    const withCycle: Project = {
      ...windowProject(30, [compoundClip('c', 'n1', window40())]),
      timelines: {
        n1: { tracks: tracks(), clips: [compoundClip('to-n2', 'n2', window40())], playheadFrame: 0 },
        n2: { tracks: tracks(), clips: [compoundClip('to-n1', 'n1', window40())], playheadFrame: 0 },
      },
    };
    expect(validateCompoundGraph(withCycle).some((error) => error.includes('cycle refused'))).toBe(true);
    expect(resolveRenderTimeline(withCycle).clips).toEqual([]);
  });

  it('resolves a dangling reference to nothing', () => {
    const project = windowProject(30, [compoundClip('c', 'gone', window40())]);
    expect(validateCompoundGraph(project).some((error) => error.includes('unknown nested timeline'))).toBe(true);
    expect(resolveRenderTimeline(project).clips).toEqual([]);
  });
});

// ─── The inverse direction: nested → render ─────────────────────────────────

/**
 * A nest `depth` deep whose compounds carry `compoundSpeeds[i]` on the level
 * whose window is `windows[i]`, with one leaf at the bottom. Windows are
 * OUTERMOST FIRST: `windows[0]` is the compound one level below main and
 * `windows[windows.length - 1]` is the one on main.
 * `depth === 1 + windows.length`.
 */
function composedProject(
  windows: CompoundWindowShape[],
  compoundSpeeds: Array<number | undefined>,
  leaf: Clip,
  leafTimelineId = 'leaf',
): Project {
  const nested: Record<string, Timeline> = {
    [leafTimelineId]: { tracks: tracks(), clips: [leaf], playheadFrame: 0, name: 'Leaf' },
  };
  for (let level = 0; level <= windows.length - 2; level += 1) {
    const next = level === windows.length - 2 ? leafTimelineId : `level-${level + 1}`;
    nested[`level-${level}`] = {
      tracks: tracks(),
      clips: [withCompoundSpeed(compoundClip(`inner-${level}`, next, windows[level]), compoundSpeeds[level])],
      playheadFrame: 0,
      name: `Level ${level}`,
    };
  }
  return {
    ...windowProject(30, [
      withCompoundSpeed(
        compoundClip('outer', windows.length === 1 ? leafTimelineId : 'level-0', windows[windows.length - 1]),
        compoundSpeeds[compoundSpeeds.length - 1],
      ),
    ]),
    timelines: nested,
  };
}

describe('a sped-up COMPOUND: the nest map is a scale and an offset, not a running sum', () => {
  it('depth 1 — a sped-up ancestor places its leaf by the one-level inverse', () => {
    // One compound, 2x, inPoint 40, startFrame 0: its own timeline frame `t` is
    // reached at nested frame `n` by `t = startFrame + (n - inPoint) / speed`.
    //   nested 100 -> t = (100 - 40) / 2 = 30 -> main 30
    //   nested 200 -> t = (200 - 40) / 2 = 80 -> main 80
    // The leaf starts at nested 100, so it renders main [30,80): 50 frames,
    // playing 50 of its own 1x source frames from 0 (its own start is the head
    // of the window, so the head cut is 0).
    const project = composedProject(
      [{ name: '2x from 40', inPoint: 40, outPoint: 240, startFrame: 0 }],
      [2],
      mediaClip({ id: 'leaf', startFrame: 100, durationFrames: 100, inPoint: 0, outPoint: 100 }),
    );
    expect(actualWindows(project)).toEqual([{
      id: 'leaf',
      startFrame: 30,
      durationFrames: 50,
      inPoint: 0,
      outPoint: 50,
      speed: undefined,
      fadeInFrames: undefined,
      fadeOutFrames: undefined,
    }]);
    // The additive sum is right at the window's head and nowhere else: the
    // legacy oracle places the same leaf 30 frames late, 100 frames long.
    expect(legacyWindows(project)[0])
      .toMatchObject({ startFrame: 60, durationFrames: 100, inPoint: 0, outPoint: 100 });
  });

  it('depth 2 — the displaced head of a trimmed window composes through both levels', () => {
    // main -> outer (1x, inPoint 20) -> inner (2x, inPoint 40) -> leaf.
    // Stepping back out one level at a time:
    //   nested 100 -> inner's timeline (100 - 40) / 2      = 30
    //             -> outer's timeline  30 - 20              = 10   (outer: 1x)
    //   nested 200 -> inner's timeline (200 - 40) / 2      = 80
    //             -> outer's timeline  80 - 20              = 60
    // So the leaf renders main [10,60). The additive sum cannot express this:
    // it adds `startFrame - inPoint` per level, which is the inverse of the map
    // only where `inPoint` and `inPoint / speed` coincide.
    const project = composedProject(
      [
        { name: 'inner 2x from 40', inPoint: 40, outPoint: 240, startFrame: 0 },
        { name: 'outer 1x from 20', inPoint: 20, outPoint: 220, startFrame: 0 },
      ],
      [2, 1],
      mediaClip({ id: 'leaf', startFrame: 100, durationFrames: 100, inPoint: 0, outPoint: 100 }),
    );
    expect(actualWindows(project)[0])
      .toMatchObject({ startFrame: 10, durationFrames: 50, inPoint: 0, outPoint: 50 });
    // Legacy: 30 frames late, and 100 frames long where 50 render.
    expect(legacyWindows(project)[0])
      .toMatchObject({ startFrame: 40, durationFrames: 100, inPoint: 0, outPoint: 100 });
  });

  it('depth 3 — two sped-up levels multiply their scales', () => {
    // main (1x from 20) -> 2x from 0 -> 2x from 0 -> leaf. Windows are
    // outermost first, so the 1x compound is `windows[2]`.
    // Stepping back out one level at a time, `t = (n - inPoint) / speed` and
    // then the parent's own map on the frame that lands in its timeline:
    //   nested 200 -> 100 ->  50 -> 30   ( (200-0)/2, then (100-0)/2, -20 )
    //   nested 400 -> 200 -> 100 -> 80
    // Scale 1/2 * 1/2 = 1/4: the leaf's 200 nested frames are 50 render frames.
    const project = composedProject(
      [
        { name: 'outer inner 2x', inPoint: 0, outPoint: 400, startFrame: 0 },
        { name: 'deepest 2x', inPoint: 0, outPoint: 400, startFrame: 0 },
        { name: 'outer 1x from 20', inPoint: 20, outPoint: 220, startFrame: 0 },
      ],
      [2, 2, 1],
      mediaClip({ id: 'leaf', startFrame: 200, durationFrames: 200, inPoint: 0, outPoint: 200 }),
    );
    expect(actualWindows(project)[0])
      .toMatchObject({ startFrame: 30, durationFrames: 50, inPoint: 0, outPoint: 50 });
    // Legacy: the summed shift walks the leaf's nested coordinates out through a
    // map that was only ever right at speed 1 — 180 instead of 30, and 20
    // frames long where 50 render.
    expect(legacyWindows(project)[0])
      .toMatchObject({ startFrame: 180, durationFrames: 20, inPoint: 0, outPoint: 20 });
  });

  it('honors a fractional speed through the same composition', () => {
    // One compound at 1.5x, inPoint 60: scale 1/1.5, offset -60/1.5 = -40.
    //   nested 200 -> t = (200 - 60) / 1.5 = 93.33 -> main 93  (rounded)
    //   nested 300 -> t = (300 - 60) / 1.5 = 160    -> main 160
    const project = composedProject(
      [{ name: '1.5x from 60', inPoint: 60, outPoint: 260, startFrame: 0 }],
      [1.5],
      mediaClip({ id: 'leaf', startFrame: 200, durationFrames: 100, inPoint: 0, outPoint: 100 }),
    );
    expect(actualWindows(project)[0])
      .toMatchObject({ startFrame: 93, durationFrames: 67, inPoint: 0, outPoint: 67 });
    // Legacy: 140 — the un-divided shift.
    expect(legacyWindows(project)[0]).toMatchObject({ startFrame: 140 });
  });

  it('leaves a sped-up CHILD where it is: a leaf\'s speed moves its window, not its placement', () => {
    // Depth 2, both compounds at 1x so the placement is a plain shift, with the
    // leaf itself at 2x. A leaf's speed changes how much SOURCE it claims for
    // the frames it occupies; it never changes how many frames it occupies, so
    // `startFrame` must be the same as the 1x case and only the window moves.
    const oneX = composedProject(
      [
        { name: 'inner 1x', inPoint: 0, outPoint: 200, startFrame: 0 },
        { name: 'outer 1x from 30', inPoint: 30, outPoint: 230, startFrame: 0 },
      ],
      [1, 1],
      mediaClip({ id: 'leaf', startFrame: 100, durationFrames: 100, inPoint: 0, outPoint: 100 }),
    );
    const twoX = composedProject(
      [
        { name: 'inner 1x', inPoint: 0, outPoint: 200, startFrame: 0 },
        { name: 'outer 1x from 30', inPoint: 30, outPoint: 230, startFrame: 0 },
      ],
      [1, 1],
      withSpeed(mediaClip({ id: 'leaf', startFrame: 100, durationFrames: 100, inPoint: 0, outPoint: 100 }), 2),
    );
    const plain = actualWindows(oneX)[0]!;
    const sped = actualWindows(twoX)[0]!;
    expect(sped.startFrame).toBe(plain.startFrame);
    expect(sped.durationFrames).toBe(plain.durationFrames);
    // Nested 100 is 30 into the inner compound's window and 30 past the outer
    // one's, so it renders at main 70 either way. The 2x leaf then claims twice
    // the source for the frames it occupies.
    expect(plain).toMatchObject({ startFrame: 70, durationFrames: 100, inPoint: 0, outPoint: 100 });
    expect(sped).toMatchObject({ startFrame: 70, durationFrames: 100, inPoint: 0, outPoint: 200, speed: 2 });
  });
});

describe('a compound carrying `speed`: how such a clip can still occur', () => {
  it('is refused by every path that writes `speed`, and no other edit writes one', () => {
    const controller = new EditorController(windowProject(30, [
      mediaClip({ id: 'a', startFrame: 0, durationFrames: 120, inPoint: 0, outPoint: 120 }),
      mediaClip({ id: 'b', startFrame: 200, durationFrames: 120, inPoint: 0, outPoint: 120 }),
    ]));
    const nest = controller.nestClips(['a']);
    // The one writer of `speed` refuses the type, loudly.
    expect(() => controller.setClipSpeed(nest.compoundClipId, 2)).toThrow(/cannot be sped up/);
    // A linked group holding a nest is refused whole, same reason — reached
    // from the partner, since the compound's own type is checked first.
    controller.linkClips([nest.compoundClipId, 'b']);
    expect(() => controller.setClipSpeed('b', 2)).toThrow(/contains compound clip/);
    controller.unlinkClips([nest.compoundClipId, 'b']);
    // Every other compound edit leaves `speed` absent, so none of them can
    // manufacture the state. (The FCPXML importer is the only other writer in
    // the repo and it refuses a compound timeMap: importer.ts reports
    // "constant speed is not imported for compound clips".)
    controller.moveClip(nest.compoundClipId, 10);
    controller.trimClip(nest.compoundClipId, 0, 100);
    controller.setClipFade(nest.compoundClipId, 5, 5);
    controller.setClipOpacity(nest.compoundClipId, 0.5);
    controller.setClipPan(nest.compoundClipId, 0.25);
    controller.setClipBlendMode(nest.compoundClipId, 'screen');
    expect(controller.setClipOpacityTrack(nest.compoundClipId, [])).toBe(false);
    expect(controller.getClips().find((clip) => clip.id === nest.compoundClipId)?.speed).toBeUndefined();
  });

  it('is reachable only through a legacy save, and `trimClip` is what re-admits it', () => {
    // The state as a project saved while `setClipSpeed` still accepted a
    // compound arrives with `outPoint - inPoint === round(duration * speed)`,
    // which the window guard rejects, so it renders as nothing. `trimClip`
    // rewrites `durationFrames = outPoint - inPoint` for ANY clip type, so one
    // trim puts the clip back inside the guard with its `speed` intact — and
    // the resolver then has to place it correctly, which is the whole subject
    // of the describe above.
    const controller = new EditorController(windowProject(30, [
      mediaClip({ id: 'a', durationFrames: 200, inPoint: 0, outPoint: 200 }),
    ]));
    const nest = controller.nestClips(['a']);
    controller.openNestedTimeline(nest.timelineId);
    const inner = controller.nestClips(['a']);
    controller.applyClipProperties([inner.compoundClipId], 'Legacy speed', (draft) => {
      draft.speed = 2;
      draft.outPoint = draft.inPoint + Math.round(draft.durationFrames * 2);
      return true;
    });
    // Guard failing: the compound is dropped, and flatten refuses it.
    expect(resolveRenderTimeline(controller.getProject()).clips).toEqual([]);
    expect(() => planFlatten(controller.getProject(), inner.compoundClipId, { scopeTimelineId: nest.timelineId }))
      .toThrow(/invalid nested window/);
    // One trim, and the same clip is inside the guard again.
    controller.trimClip(inner.compoundClipId, 0, 400);
    const restored = controller.getClips()[0]!;
    expect(restored.speed).toBe(2);
    expect(restored.durationFrames).toBe(restored.outPoint - restored.inPoint);
    expect(validateCompoundGraph(controller.getProject())).toEqual([]);
    expect(resolveRenderTimeline(controller.getProject()).clips).toHaveLength(1);
  });
});

describe('resolve → flatten round-trips the window it came from', () => {
  /** Flatten every compound in the project, outermost first, until none remain. */
  function flattenAll(project: Project): Project {
    let next = project;
    for (let pass = 0; pass <= MAX_COMPOUND_DEPTH; pass += 1) {
      const outermost = next.timeline.clips.find((clip) => clip.type === 'compound');
      if (!outermost) break;
      next = planFlatten(next, outermost.id).project;
    }
    return next;
  }

  /** Timing only: flatten restores inner track ids, not the resolved namespace. */
  const timing = (clips: readonly Clip[]) => clips
    .map((clip) => ({
      id: clip.id,
      startFrame: clip.startFrame,
      durationFrames: clip.durationFrames,
      inPoint: clip.inPoint,
      outPoint: clip.outPoint,
    }))
    .sort((left, right) => left.startFrame - right.startFrame || (left.id < right.id ? -1 : 1));

  for (const depth of [1, 2, 3] as const) {
    it(`lands every resolved leaf back where it rendered at depth ${depth}`, () => {
      // Windows that do NOT crop the leaf: the resolver emits the visible part
      // of a clip and flatten restores the whole clip, so an exact match is a
      // statement about an untrimmed nest. Every level sits 100 frames along
      // its parent, so the round trip is exercised at a non-zero shift and the
      // expected render position is 100 * depth.
      const windows: CompoundWindowShape[] = Array.from(
        { length: depth },
        (_unused, level) => ({ name: `level-${level}`, inPoint: 0, outPoint: 400, startFrame: 100 }),
      );
      const project = matrixProject(30, depth, CHILD_LAYOUTS[0].clips, windows);
      const resolved = timing(resolveRenderTimeline(project).clips);
      expect(resolved).toHaveLength(1);
      expect(resolved[0]!.startFrame).toBe(100 * depth);
      expect(timing(flattenAll(project).timeline.clips)).toEqual(resolved);
    });
  }

  it('agrees with flatten on the mapping when the outer window is trimmed', () => {
    // Flatten restores the FULL nested content by contract, so a trimmed nest
    // restores the whole leaf at the position of its own start — including the
    // head the window hides. The two therefore describe different spans of one
    // clip, and the property that must hold between them is the MAPPING: the
    // same number of frames into the clip, counted in render space, is the same
    // number of frames into its source.
    const project = matrixProject(30, 2, CHILD_LAYOUTS[0].clips, [
      { name: 'inner full', inPoint: 0, outPoint: 200, startFrame: 0 },
      { name: 'outer trimmed', inPoint: 20, outPoint: 120, startFrame: 0 },
    ]);
    const resolved = timing(resolveRenderTimeline(project).clips);
    expect(resolved).toHaveLength(1);
    const flat = timing(flattenAll(project).timeline.clips);
    expect(flat).toHaveLength(1);
    const leaf = resolved[0]!;
    const whole = flat[0]!;
    expect(whole.id).toBe(leaf.id);
    // The whole clip is restored at its own start, 20 frames before the visible
    // slice, and the resolved head cut into the source is exactly that 20.
    expect(whole.startFrame).toBe(leaf.startFrame - 20);
    expect(leaf.inPoint - whole.inPoint).toBe(leaf.startFrame - whole.startFrame);
    // And the visible span is contained in the whole one.
    expect(leaf.startFrame).toBeGreaterThanOrEqual(whole.startFrame);
    expect(leaf.startFrame + leaf.durationFrames)
      .toBeLessThanOrEqual(whole.startFrame + whole.durationFrames);
  });
});

describe('flatten places a sped-up compound\'s children on the composed map', () => {
  const SPEEDS = [0.5, 0.75, 1.25, 2, 4];
  const HEAD = 0; // nested frames past the window start for the child ON the head
  const AWAY = 40; // a nested frame far enough that the old sum is visibly wrong
  // The compound's window deliberately does NOT start at nested frame 0. With
  // `inPoint === 0` the `inPoint / speed` term in the offset multiplies nothing,
  // so a fixture like that cannot tell the correct offset from the old additive
  // one -- mutation M4 survives it. A window starting at 24 makes that term
  // observable, and it is what the `trimClip` route above actually leaves
  // behind: the compound is built whole, then its window is trimmed inward.
  const WINDOW_START = 24;
  const WINDOW_END = 240;

  /**
   * The only route to a compound carrying `speed` is a legacy save plus one
   * `trimClip` (the describe above), and the state that leaves is exactly
   * `speed` set with the window invariant back in force. Child `a` sits ON the
   * window head, child `b` sits `AWAY` frames past it.
   */
  function spedUpNest(speed: number, withKeyframes = false): { project: Project; compoundId: string; head: Frame; away: Frame } {
    const nested = planNest(windowProject(30, [
      mediaClip({ id: 'a', startFrame: WINDOW_START, durationFrames: 240, inPoint: 0, outPoint: 240 }),
    ]), ['a']).project;
    const compound = nested.timeline.clips[0]!;
    const leafId = Object.keys(nested.timelines!)[0]!;
    // Read off the window this helper actually writes below, not the one
    // `planNest` happened to produce.
    const head = WINDOW_START + HEAD;
    const away = WINDOW_START + AWAY;
    return {
      compoundId: compound.id,
      head,
      away,
      project: {
        ...nested,
        timeline: {
          ...nested.timeline,
          clips: nested.timeline.clips.map((clip) => (clip.id === compound.id
            ? {
              ...clip,
              speed,
              inPoint: WINDOW_START,
              outPoint: WINDOW_END,
              durationFrames: WINDOW_END - WINDOW_START,
            }
            : clip)),
        },
        timelines: {
          ...nested.timelines!,
          [leafId]: {
            ...nested.timelines![leafId]!,
            clips: [
              // `a` ON the window head, `b` AWAY past it. The window is
              // [WINDOW_START, WINDOW_END), so both starts are inside it.
              ...nested.timelines![leafId]!.clips.map((clip) => (clip.id === 'a'
                ? { ...clip, startFrame: WINDOW_START }
                : clip)),
              mediaClip({
                id: 'b',
                startFrame: away,
                durationFrames: 30,
                inPoint: 0,
                outPoint: 30,
                ...(withKeyframes
                  ? { motionX: [{ frame: away, value: 0 }, { frame: away + 30, value: 10 }] }
                  : {}),
              }),
            ],
          },
        },
      },
    };
  }

  it('agrees with the render path for every speed, on a child past the window head', () => {
    for (const speed of SPEEDS) {
      const { project, compoundId, head, away } = spedUpNest(speed);
      const compound = project.timeline.clips.find((clip) => clip.id === compoundId)!;
      const rendered = resolveRenderTimeline(project).clips.filter((clip) => clip.id !== compoundId);
      const flat = planFlatten(project, compoundId).project;
      expect(rendered.map((clip) => clip.id).sort()).toEqual(['a', 'b']);
      for (const r of rendered) {
        const f = flat.timeline.clips.find((clip) => clip.id === r.id);
        expect(f, `speed ${speed}: ${r.id} missing from the flattened timeline`).toBeDefined();
        expect(f!.startFrame, `speed ${speed}: ${r.id} landed away from where it rendered`).toBe(r.startFrame);
      }
      // The child past the head is the one that discriminates: it must move.
      const bFlat = flat.timeline.clips.find((clip) => clip.id === 'b')!.startFrame;
      const composed = Math.round(away / speed + (compound.startFrame - compound.inPoint / speed));
      const oldSum = away + (compound.startFrame - compound.inPoint);
      expect(bFlat, `speed ${speed}: child past the head was not rescaled`).toBe(composed);
      // And it is genuinely not the pre-fix displacement, except where the
      // window head coincidence makes the two the same integer.
      if (away !== compound.inPoint) {
        expect(bFlat, `speed ${speed}: child past the head still on the old sum`).not.toBe(oldSum);
      }
      expect(head).toBe(compound.inPoint);
    }
  });

  it('the window head is the ONE point where the old additive sum was exact', () => {
    // This is why the defect read as "right at the start, stretched after": at
    // `n === inPoint` the sum and the composed map agree to the frame, so a
    // regression test written only at the head passes on a broken fix. Every
    // assertion above therefore uses a child PAST the head.
    for (const speed of SPEEDS) {
      const { project, compoundId, head } = spedUpNest(speed);
      const compound = project.timeline.clips.find((clip) => clip.id === compoundId)!;
      const oldSum = head + (compound.startFrame - compound.inPoint);
      const flat = planFlatten(project, compoundId).project;
      const aFlat = flat.timeline.clips.find((clip) => clip.id === 'a')!.startFrame;
      // The old formula's value, and the composed map's, are the same integer.
      expect(aFlat, `speed ${speed}: head child moved off the coincidence point`).toBe(oldSum);
      expect(aFlat).toBe(Math.round(head / speed + (compound.startFrame - compound.inPoint / speed)));
    }
  });

  it('speed 1 is untouched: the pair collapses to the old additive sum', () => {
    const { project, compoundId, away } = spedUpNest(1, true);
    const compound = project.timeline.clips.find((clip) => clip.id === compoundId)!;
    const oldSum = compound.startFrame - compound.inPoint;
    const flat = planFlatten(project, compoundId).project;
    for (const id of ['a', 'b']) {
      const f = flat.timeline.clips.find((clip) => clip.id === id)!;
      const nestedStart = id === 'a' ? compound.inPoint + HEAD : away;
      expect(f.startFrame, `speed 1: ${id} placement changed`).toBe(nestedStart + oldSum);
    }
    // Keyframes keep the pre-fix rebasing exactly: `round(v * 1) + oldSum`, which
    // at scale 1 is a pure shift. `a` carries none, so it must still have none.
    expect(flat.timeline.clips.find((clip) => clip.id === 'a')!.motionX).toBeUndefined();
    expect(flat.timeline.clips.find((clip) => clip.id === 'b')!.motionX?.map((point) => point.frame))
      .toEqual([away + oldSum, away + 30 + oldSum]);
  });

  it('rebases keyframes through the same scale, not just the offset', () => {
    for (const speed of SPEEDS) {
      const { project, compoundId, away } = spedUpNest(speed, true);
      const compound = project.timeline.clips.find((clip) => clip.id === compoundId)!;
      const flat = planFlatten(project, compoundId).project;
      const f = flat.timeline.clips.find((clip) => clip.id === 'b')!;
      const offset = compound.startFrame - compound.inPoint / speed;
      expect(f.motionX?.map((point) => point.frame), `speed ${speed}: keyframes not scaled`)
        .toEqual([Math.round(away / speed) + offset, Math.round((away + 30) / speed) + offset]);
    }
  });

  it('at depth 2 the inner compound lands where the render map puts it', () => {
    // The error is `(n - inPoint) * (1 - 1/speed)`, so it is largest for the
    // deepest child furthest from the head: the inner compound below starts 40
    // frames into the outer nest, under an outer compound running at 2x.
    const controller = new EditorController(windowProject(30, [
      mediaClip({ id: 'a', startFrame: 0, durationFrames: 240, inPoint: 0, outPoint: 240 }),
    ]));
    const outer = controller.nestClips(['a']);
    controller.openNestedTimeline(outer.timelineId);
    const inner = controller.nestClips(['a']);
    controller.moveClip(inner.compoundClipId, 40);
    // Back to main: the OUTER compound is the one being sped up, and `getClips`
    // only ever answers for the open scope.
    controller.navigateToScope(null);
    // Legacy state on the outer compound, then the one trim that re-admits it.
    controller.applyClipProperties([outer.compoundClipId], 'Legacy speed', (draft) => {
      draft.speed = 2;
      draft.outPoint = draft.inPoint + Math.round(draft.durationFrames * 2);
      return true;
    });
    expect(() => planFlatten(controller.getProject(), outer.compoundClipId)).toThrow(/invalid nested window/);
    controller.trimClip(outer.compoundClipId, 0, 100);
    const project = controller.getProject();
    const outerClip = project.timeline.clips.find((clip) => clip.id === outer.compoundClipId)!;
    expect(outerClip.durationFrames).toBe(100);
    const innerNestedStart = project.timelines![outerClip.compoundTimelineId!]!.clips
      .find((clip) => clip.id === inner.compoundClipId)!.startFrame;
    const speed = effectiveSpeed(outerClip.speed);
    const flat = planFlatten(project, outer.compoundClipId).project;
    const placed = flat.timeline.clips.find((clip) => clip.id === inner.compoundClipId);
    expect(placed, 'flatten should have lifted the inner compound into the main timeline').toBeDefined();
    // The composed map, and the sum the pre-fix code used. They differ by
    // `(n - inPoint) * (1 - 1/speed)` = 40 * 0.5 = 20 frames here.
    const composed = Math.round(innerNestedStart / speed + (outerClip.startFrame - outerClip.inPoint / speed));
    const oldSum = innerNestedStart + (outerClip.startFrame - outerClip.inPoint);
    expect(placed!.startFrame, 'the depth-2 child landed away from the composed map').toBe(composed);
    expect(oldSum - placed!.startFrame).toBe(Math.round(innerNestedStart * (1 - 1 / speed)));
  });
});
