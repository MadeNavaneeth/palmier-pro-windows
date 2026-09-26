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
 * A nest `depth` compounds deep whose innermost timeline holds `children`, with
 * the inner compound on `innerWindow` and the outer on `outerWindow`.
 */
function matrixProject(
  fps: number,
  depth: 1 | 2,
  children: Clip[],
  innerWindow: CompoundWindowShape,
  outerWindow: CompoundWindowShape,
): Project {
  const leafId = 'leaf';
  const innerId = 'inner-seq';
  const nested: Record<string, Timeline> = {
    [leafId]: { tracks: tracks(), clips: children, playheadFrame: 0, name: 'Leaf' },
  };
  if (depth === 2) {
    nested[innerId] = {
      tracks: tracks(),
      clips: [compoundClip('inner-clip', leafId, innerWindow)],
      playheadFrame: 0,
      name: 'Inner',
    };
  }
  return {
    ...windowProject(fps, [compoundClip('outer-clip', depth === 2 ? innerId : leafId, outerWindow)]),
    timelines: nested,
  };
}

/** Every matrix case at the given child speed. */
function* matrixCases(childSpeed: number | undefined): Generator<{ label: string; project: Project }> {
  for (const fps of FRAME_RATES) {
    for (const depth of [1, 2] as const) {
      for (const outer of WINDOW_SHAPES) {
        for (const inner of WINDOW_SHAPES) {
          for (const layout of CHILD_LAYOUTS) {
            const children = layout.clips.map((clip) => (
              childSpeed === undefined
                ? { ...clip }
                // `setClipSpeed` writes outPoint from the scaled duration; keep
                // the fixture self-consistent with the speed command.
                : { ...clip, speed: childSpeed, outPoint: clip.inPoint + Math.round(clip.durationFrames * childSpeed) }
            ));
            yield {
              label: `fps=${fps} depth=${depth} outer=${outer.name} inner=${inner.name} children=${layout.name}`,
              project: matrixProject(fps, depth, children, inner, outer),
            };
          }
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
    // 4 fps x 2 depths x 5 x 5 window shapes x 4 child layouts.
    expect(checked).toBe(4 * 2 * 5 * 5 * 4);
  });

  it('matches it identically for an explicit `speed: 1`', () => {
    let checked = 0;
    for (const { label, project } of matrixCases(1)) {
      expect(actualWindows(project), label).toEqual(legacyWindows(project));
      checked += 1;
    }
    expect(checked).toBe(4 * 2 * 5 * 5 * 4);
  });

  it('is frame-rate invariant: the same case resolves identically at 24/25/30/60', () => {
    for (const depth of [1, 2] as const) {
      for (const outer of WINDOW_SHAPES) {
        for (const inner of WINDOW_SHAPES) {
          const children = CHILD_LAYOUTS[3].clips;
          const reference = actualWindows(
            matrixProject(24, depth, children, inner, outer),
          );
          for (const fps of [25, 30, 60]) {
            expect(
              actualWindows(matrixProject(fps, depth, children, inner, outer)),
              `fps=${fps} depth=${depth} outer=${outer.name} inner=${inner.name}`,
            ).toEqual(reference);
          }
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
    // so the visible part is [120,200) — 80 frames from source frame 120.
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toMatchObject({ durationFrames: 80, inPoint: 120, outPoint: 200 });
    // The pre-fix oracle reads the same project as the full [60,200).
    expect(legacyWindows(controller.getProject())[0])
      .toMatchObject({ durationFrames: 140, inPoint: 60, outPoint: 200 });
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
    // nested one at 2x, so the leaf renders whole and both ramps apply.
    //   fadeIn  = round(20 * 2)  = 40
    //   fadeOut = round(30 * 2)  = 60
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toMatchObject({ durationFrames: 200, inPoint: 0, outPoint: 200, fadeInFrames: 40, fadeOutFrames: 60 });
    // Legacy: the ramps stayed 20 and 30 nested frames long — and because the
    // legacy child window also drops the term, it is [0,100) rather than
    // [0,200), so the leaf is cut in half as well.
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
