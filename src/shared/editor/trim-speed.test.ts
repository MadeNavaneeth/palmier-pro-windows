/**
 * The two spaces of a clip's trim window, on the two paths that write them.
 *
 * A user edge drag (`trimClipEdge`) and a source-window trim (`trimClip` /
 * `TrimClipCommand`) both edit a window whose `inPoint`/`outPoint` are SOURCE
 * frames while `durationFrames` is a TIMELINE length. The shared source-time
 * model relates them: source time advances `speed` frames per timeline frame,
 * so the window is `inPoint + round(durationFrames * speed)` wide -- the shape
 * `setClipSpeed` writes, and the shape `sourceWindowForSlice` rebuilds. Both
 * paths here once wrote the source window as if the drag were measured in the
 * same space, so a sped-up clip ended each edit disagreeing with itself.
 *
 * The differential matrix pins the promise that matters most: at speed 1 the
 * edge drag is byte-identical to the arithmetic it replaced.
 */

import { describe, expect, it, vi } from 'vitest';
import { EditorController, type TrimEdge } from './controller';
import { CommandHistory, TrimClipCommand } from './commands';
import {
  clipTrimSeconds,
  effectiveSpeed,
  sourceSecondsForTimelineFrame,
} from '../media/source-time';
import {
  createEmptyProject,
  type Clip,
  type Frame,
  type MediaAsset,
  type Project,
} from '../types/project';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function asset(id: string, duration: Frame): MediaAsset {
  return {
    id,
    path: `C:\\media\\${id}.mp4`,
    filename: `${id}.mp4`,
    type: 'video',
    duration,
    fileSize: 100,
    addedAt: '2026-09-26T00:00:00.000Z',
  };
}

function clipFixture(options: {
  id?: string;
  startFrame: Frame;
  durationFrames: Frame;
  inPoint: Frame;
  speed?: number;
  /** Stale by construction when set: an out point that ignores the speed. */
  outPoint?: Frame;
}): Clip {
  const id = options.id ?? 'lead';
  const speed = options.speed;
  return {
    id,
    assetId: id,
    type: 'video',
    trackId: 'v1',
    startFrame: options.startFrame,
    durationFrames: options.durationFrames,
    inPoint: options.inPoint,
    outPoint: options.outPoint
      ?? options.inPoint + Math.round(options.durationFrames * effectiveSpeed(speed)),
    ...(speed === undefined ? {} : { speed }),
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    opacity: 1,
    anchorX: 960,
    anchorY: 540,
    volume: 1,
    muted: false,
  };
}

function trimProject(
  fps: number,
  clips: Clip[],
  assetDuration: Frame,
  options: { locked?: boolean } = {},
): Project {
  const base = createEmptyProject('Trim speed test');
  return {
    ...base,
    settings: { ...base.settings, fps },
    media: [asset('lead', assetDuration)],
    timeline: {
      ...base.timeline,
      tracks: base.timeline.tracks.map((track) =>
        options.locked && track.id === 'v1' ? { ...track, locked: true } : track,
      ),
      clips,
    },
  };
}

function geometry(clip: Clip): Record<string, Frame> {
  return {
    startFrame: clip.startFrame,
    durationFrames: clip.durationFrames,
    inPoint: clip.inPoint,
    outPoint: clip.outPoint,
  };
}

/**
 * The pre-fix `trimClipEdge` arithmetic, copied verbatim: the drag distance is
 * applied to the source window as-is, and the headroom that bounds it is read
 * in source frames too. Single unsplit clip on its own track, so the compound
 * branch, the linked-group expansion and the ripple follower scan have nothing
 * to do -- the asset's duration arrives as a parameter, standing in for the
 * `this.project.media` lookup.
 */
function legacyTrimEdge(
  before: Clip,
  assetDuration: Frame,
  edge: TrimEdge,
  deltaFrames: number,
  ripple: boolean,
): Record<string, Frame> | null {
  const requestedDelta = Math.round(deltaFrames);
  if (!Number.isFinite(requestedDelta) || requestedDelta === 0) return null;
  const durationDeltaRequested = edge === 'right' ? requestedDelta : -requestedDelta;
  const minDurationDelta = -(before.durationFrames - 1);
  const maxDurationDelta = edge === 'left'
    ? (ripple ? before.inPoint : Math.min(before.inPoint, before.startFrame))
    : (assetDuration > 0
      ? Math.max(0, assetDuration - before.outPoint)
      : Number.POSITIVE_INFINITY);
  const durationDelta = Math.min(
    maxDurationDelta,
    Math.max(minDurationDelta, durationDeltaRequested),
  );
  if (!Number.isFinite(durationDelta) || durationDelta === 0) return null;
  if (edge === 'right') {
    return {
      startFrame: before.startFrame,
      durationFrames: before.durationFrames + durationDelta,
      inPoint: before.inPoint,
      outPoint: before.outPoint + durationDelta,
    };
  }
  return {
    startFrame: ripple ? before.startFrame : before.startFrame - durationDelta,
    durationFrames: before.durationFrames + durationDelta,
    inPoint: before.inPoint - durationDelta,
    outPoint: before.outPoint,
  };
}

// ─── Site 1: the edge drag ─────────────────────────────────────────────────────

describe('trimClipEdge maps the drag through the clip speed', () => {
  const FPS = 30;

  it('lengthens a 2x clip by moving the window twice as far', () => {
    const before = clipFixture({ startFrame: 20, durationFrames: 100, inPoint: 40, speed: 2 });
    expect(before.outPoint).toBe(240);
    const ctrl = new EditorController(trimProject(FPS, [before], 600));

    const report = ctrl.trimClipEdge('lead', 'right', 10);

    const after = ctrl.getClips()[0]!;
    expect(report?.durationDelta).toBe(10);
    expect(geometry(after)).toEqual({
      startFrame: 20,
      durationFrames: 110,
      inPoint: 40,
      // By hand, through the shared model: the window is
      // `inPoint + round(durationFrames * speed)` = 40 + 220 = 260, which is
      // where the clip's new last timeline frame lands:
      // `inPoint + (20 + 110 - 20) * 2` = 260.
      outPoint: 260,
    });
    // The pre-fix arithmetic moved the source window by the drag distance
    // itself; dropping the `speed` term reproduces exactly that value.
    expect(after.outPoint).not.toBe(240 + 10);
    // And the shared model reads the two fields back as one window.
    expect(sourceSecondsForTimelineFrame(after, after.startFrame + after.durationFrames, FPS))
      .toBeCloseTo(after.outPoint / FPS, 10);
    expect(clipTrimSeconds(after, FPS).end).toBeCloseTo(after.outPoint / FPS, 10);
  });

  it('shortens a 2x clip by moving the window twice as far', () => {
    const before = clipFixture({ startFrame: 20, durationFrames: 100, inPoint: 40, speed: 2 });
    const ctrl = new EditorController(trimProject(FPS, [before], 600));

    const report = ctrl.trimClipEdge('lead', 'right', -30);

    const after = ctrl.getClips()[0]!;
    expect(report?.durationDelta).toBe(-30);
    expect(geometry(after)).toEqual({
      startFrame: 20,
      durationFrames: 70,
      inPoint: 40,
      outPoint: 180, // 40 + round(70 * 2)
    });
    expect(after.outPoint).not.toBe(240 - 30);
  });

  it('drags the left edge of a 2x clip by the source distance the edge travelled', () => {
    const before = clipFixture({ startFrame: 200, durationFrames: 100, inPoint: 30, speed: 2 });
    const ctrl = new EditorController(trimProject(FPS, [before], 600));

    // Pull the edge 10 timeline frames right: the clip shortens by 10, and the
    // material under the new edge is 20 source frames further in.
    const report = ctrl.trimClipEdge('lead', 'left', 10);

    const after = ctrl.getClips()[0]!;
    expect(report?.durationDelta).toBe(-10);
    expect(geometry(after)).toEqual({
      startFrame: 210,
      durationFrames: 90,
      inPoint: 50, // sourceFrameAtBoundary(clip, 210) = 30 + round(10 * 2)
      outPoint: 230, // untouched: the out end is not the edge being dragged
    });
    expect(after.inPoint).not.toBe(30 + 10);
    // The window still describes the clip: the frame at `startFrame` shows
    // `inPoint`, and the span is `durationFrames * speed` wide.
    expect(sourceSecondsForTimelineFrame(after, after.startFrame, FPS))
      .toBeCloseTo(after.inPoint / FPS, 10);
    expect(after.outPoint - after.inPoint)
      .toBe(Math.round(after.durationFrames * effectiveSpeed(after.speed)));
  });

  it('grabs the material with the edge on a ripple left drag too', () => {
    const before = clipFixture({ startFrame: 200, durationFrames: 100, inPoint: 30, speed: 2 });
    const follower = clipFixture({ id: 'next', startFrame: 320, durationFrames: 40, inPoint: 0 });
    const ctrl = new EditorController(trimProject(FPS, [before, follower], 600));

    const report = ctrl.trimClipEdge('lead', 'left', 10, true);

    // The timeline start stays put and the follower closes the gap, but the
    // grabbed material moved with the edge -- the same window as the
    // non-ripple drag above.
    expect(ctrl.getClips()[0]).toMatchObject({ startFrame: 200, durationFrames: 90, inPoint: 50 });
    expect(ctrl.getClips()[1]!.startFrame).toBe(310);
    expect(report?.shiftedClipIds).toEqual(['next']);
  });

  it('rescales the right-edge headroom so a drag stops at the end of the asset', () => {
    // 220 source frames of asset left after the clip: 110 timeline frames at 2x.
    const before = clipFixture({ startFrame: 20, durationFrames: 100, inPoint: 40, speed: 2 });
    const ctrl = new EditorController(trimProject(FPS, [before], 460));

    const report = ctrl.trimClipEdge('lead', 'right', 3000);

    const after = ctrl.getClips()[0]!;
    expect(report?.durationDelta).toBe(110);
    expect(after.durationFrames).toBe(210);
    expect(after.outPoint).toBe(460); // the asset's own end, not past it
    expect(after.outPoint).toBeLessThanOrEqual(460);
    expect(after.outPoint - after.inPoint)
      .toBe(Math.round(after.durationFrames * effectiveSpeed(after.speed)));
    // Nothing left: the headroom is spent, and the bound was computed against
    // the new scale rather than the old one.
    expect(ctrl.trimClipEdge('lead', 'right', 10)).toBeNull();
  });

  it('rescales the left-edge headroom so a drag stops at the start of the asset', () => {
    // 30 source frames before the clip: 15 timeline frames of drag at 2x.
    const before = clipFixture({ startFrame: 200, durationFrames: 100, inPoint: 30, speed: 2 });
    const ctrl = new EditorController(trimProject(FPS, [before], 600));

    // Drag the edge left (lengthen): the pre-fix bound was the source number
    // itself, 30, which is twice the drag the media has room for.
    const report = ctrl.trimClipEdge('lead', 'left', -60);

    const after = ctrl.getClips()[0]!;
    expect(report?.durationDelta).toBe(15);
    expect(geometry(after)).toEqual({
      startFrame: 185,
      durationFrames: 115,
      inPoint: 0,
      outPoint: 230,
    });
    expect(after.inPoint).toBeGreaterThanOrEqual(0);
    expect(after.outPoint - after.inPoint)
      .toBe(Math.round(after.durationFrames * effectiveSpeed(after.speed)));
  });

  it('keeps the drag on the speed the setter wrote, end to end', () => {
    const ctrl = new EditorController(trimProject(FPS, [
      clipFixture({ startFrame: 0, durationFrames: 100, inPoint: 0 }),
    ], 600));

    expect(ctrl.setClipSpeed('lead', 2)).toBe(true);
    ctrl.trimClipEdge('lead', 'right', 25);

    const after = ctrl.getClips()[0]!;
    expect(after).toMatchObject({ durationFrames: 125, inPoint: 0, outPoint: 250, speed: 2 });
  });

  it('repairs a window that already ignored the clip speed, rather than sliding it', () => {
    // A project saved while `setClipSpeed` scaled `outPoint` but not the
    // window's agreement with `durationFrames` (`outPoint - inPoint` = 150 for
    // 100 timeline frames at 2x). The dragged boundary is what the model
    // answers for, so the rebuilt window is measured from the in point and the
    // clip comes back into agreement with itself.
    const stale = clipFixture({
      startFrame: 20,
      durationFrames: 100,
      inPoint: 40,
      outPoint: 190,
      speed: 2,
    });
    const ctrl = new EditorController(trimProject(FPS, [stale], 600));

    ctrl.trimClipEdge('lead', 'right', 10);

    const after = ctrl.getClips()[0]!;
    expect(after.durationFrames).toBe(110);
    expect(after.outPoint).toBe(260);
    expect(after.outPoint - after.inPoint)
      .toBe(Math.round(after.durationFrames * effectiveSpeed(after.speed)));
  });
});

describe('trimClipEdge at speed 1 is byte-identical to the arithmetic it replaced', () => {
  interface Layout {
    name: string;
    assetDuration: number;
    startFrame: number;
    durationFrames: number;
    inPoint: number;
  }

  const LAYOUTS: Layout[] = [
    { name: 'mid-asset', assetDuration: 300, startFrame: 20, durationFrames: 100, inPoint: 40 },
    { name: 'at asset start', assetDuration: 300, startFrame: 0, durationFrames: 60, inPoint: 0 },
    { name: 'at asset end', assetDuration: 300, startFrame: 200, durationFrames: 100, inPoint: 200 },
    { name: 'fills the asset', assetDuration: 300, startFrame: 0, durationFrames: 300, inPoint: 0 },
    {
      name: 'one frame of headroom at each end',
      assetDuration: 300,
      startFrame: 1,
      durationFrames: 298,
      inPoint: 1,
    },
  ];
  const EDGES: TrimEdge[] = ['left', 'right'];
  const DRAGS = [1, -1, 7, -13, 50, -50, 3000, -3000, 0.5, -0.4, 2.6];
  const FPS_RATES = [24, 25, 30, 60];

  it.each(FPS_RATES)('matches the pre-fix result on every layout and drag at %i fps', (fps) => {
    // Same layouts in seconds, expressed at this project's rate, so each rate
    // is a genuinely different frame layout rather than the same one thrice.
    const scale = fps / 30;
    const at = (value: number): Frame => Math.round(value * scale);
    let compared = 0;

    for (const layout of LAYOUTS) {
      const before = clipFixture({
        startFrame: at(layout.startFrame),
        durationFrames: at(layout.durationFrames),
        inPoint: at(layout.inPoint),
      });
      // Built so `outPoint - inPoint === durationFrames`, the invariant the
      // shared model maintains (`outPoint = inPoint + round(durationFrames *
      // speed)` at speed 1) and the one the pre-fix window obeyed exactly.
      const assetDuration = at(layout.assetDuration);

      for (const edge of EDGES) {
        for (const ripple of [false, true]) {
          for (const drag of DRAGS) {
            const ctrl = new EditorController(trimProject(fps, [before], assetDuration));
            const report = ctrl.trimClipEdge('lead', edge, drag, ripple);
            const after = ctrl.getClips()[0]!;
            const legacy = legacyTrimEdge(before, assetDuration, edge, drag, ripple);
            const where = `${layout.name} ${edge} drag=${drag} ripple=${ripple}`;

            if (legacy === null) {
              expect(report, where).toBeNull();
              expect(geometry(after), where).toEqual(geometry(before));
            } else {
              expect(report, where).not.toBeNull();
              expect(report!.durationDelta, where)
                .toBe(legacy.durationFrames - before.durationFrames);
              expect(geometry(after), where).toEqual(legacy);
            }
            compared += 1;
          }
        }
      }
    }

    expect(compared).toBe(LAYOUTS.length * EDGES.length * DRAGS.length * 2);
  });
});

describe('trimClipEdge keeps its transaction and refusal contract', () => {
  const FPS = 30;

  /**
   * Collect the label of every command committed inside `body`. The label is
   * private to the command, so this is the only way to see the one the user
   * would read back from the undo stack.
   */
  function withCommandLabels(body: (labels: string[]) => void): void {
    const original = CommandHistory.prototype.execute;
    const labels: string[] = [];
    const spy = vi.spyOn(CommandHistory.prototype, 'execute')
      .mockImplementation(function (this: CommandHistory, command, project) {
        labels.push(command.describe());
        return original.call(this, command, project);
      });
    try {
      body(labels);
    } finally {
      spy.mockRestore();
    }
  }

  function spedUpProject(): { ctrl: EditorController; before: Clip } {
    const before = clipFixture({ startFrame: 20, durationFrames: 100, inPoint: 40, speed: 2 });
    return { ctrl: new EditorController(trimProject(FPS, [before], 600)), before };
  }

  it('is one undo step per drag, under the same labels', () => {
    for (const speed of [1, 2]) {
      const before = clipFixture({
        startFrame: 20,
        durationFrames: 100,
        inPoint: 40,
        ...(speed === 1 ? {} : { speed: 2 }),
      });
      const ctrl = new EditorController(trimProject(FPS, [before], 600));
      let afterFirstDrag: Record<string, Frame> = {};

      withCommandLabels((labels) => {
        ctrl.trimClipEdge('lead', 'right', 10);
        afterFirstDrag = geometry(ctrl.getClips()[0]!);
        expect(labels).toEqual(['Trim clip']);
        expect(ctrl.getLastCommandDescription()).toBe('replaceClips');
        labels.length = 0;

        ctrl.trimClipEdge('lead', 'left', 10, true);
        expect(labels).toEqual(['Ripple trim clips']);
      });

      // Two drags, two entries: each undo steps back exactly one drag.
      expect(ctrl.undo()).toBe(true);
      expect(geometry(ctrl.getClips()[0]!)).toEqual(afterFirstDrag);
      expect(ctrl.undo()).toBe(true);
      expect(ctrl.getClips()[0]).toMatchObject(geometry(before));
      expect(ctrl.undo()).toBe(false);
    }
  });

  it('refuses a locked track, an unknown clip, and a drag with no distance', () => {
    const { ctrl } = spedUpProject();
    expect(ctrl.trimClipEdge('ghost', 'right', 10)).toBeNull();
    expect(ctrl.trimClipEdge('lead', 'right', 0)).toBeNull();
    expect(ctrl.trimClipEdge('lead', 'right', Number.NaN)).toBeNull();
    expect(ctrl.canUndo()).toBe(false);

    const locked = new EditorController(trimProject(FPS, [
      clipFixture({ startFrame: 20, durationFrames: 100, inPoint: 40, speed: 2 }),
    ], 600, { locked: true }));
    expect(locked.trimClipEdge('lead', 'right', 10)).toBeNull();
    expect(locked.trimClipEdge('lead', 'left', -10)).toBeNull();
    expect(locked.canUndo()).toBe(false);
  });

  it('refuses a clip with no headroom in the dragged direction', () => {
    const { ctrl } = spedUpProject();
    // Window pinned at both ends of a 2x clip: the asset ends where it starts.
    const pinned = new EditorController(trimProject(FPS, [
      clipFixture({ startFrame: 0, durationFrames: 200, inPoint: 0, speed: 2 }),
    ], 400));

    expect(pinned.trimClipEdge('lead', 'right', 5)).toBeNull();
    expect(pinned.trimClipEdge('lead', 'left', -5)).toBeNull();
    expect(pinned.canUndo()).toBe(false);
    // The same clip can still be trimmed in the directions that have room.
    expect(ctrl.trimClipEdge('lead', 'right', 10)).not.toBeNull();
  });
});

// ─── Site 2: the source-window trim ────────────────────────────────────────────

describe('trimClip derives the timeline length from the source window', () => {
  const FPS = 30;

  it('halves the length of a 2x clip trimmed to a 300-frame source window', () => {
    const ctrl = new EditorController(trimProject(FPS, [
      clipFixture({ startFrame: 20, durationFrames: 100, inPoint: 0, speed: 2 }),
    ], 900));

    ctrl.trimClip('lead', 100, 400);

    const after = ctrl.getClips()[0]!;
    // The window is the input: 300 source frames at 2x is 150 timeline frames.
    expect(after).toMatchObject({ inPoint: 100, outPoint: 400, durationFrames: 150 });
    // Invariant: the two spaces agree, so the window still describes the clip.
    expect(after.outPoint - after.inPoint)
      .toBe(Math.round(after.durationFrames * effectiveSpeed(after.speed)));
    // And the shared model reads both endpoints back out of it.
    expect(sourceSecondsForTimelineFrame(after, after.startFrame, FPS)).toBeCloseTo(100 / FPS, 10);
    expect(sourceSecondsForTimelineFrame(
      after,
      after.startFrame + after.durationFrames,
      FPS,
    )).toBeCloseTo(400 / FPS, 10);
    // The pre-fix arithmetic took the source span for the timeline length.
    expect(after.durationFrames).not.toBe(400 - 100);
  });

  it('leaves a speed-1 clip length exactly the window span', () => {
    const ctrl = new EditorController(trimProject(FPS, [
      clipFixture({ startFrame: 20, durationFrames: 100, inPoint: 0 }),
    ], 900));

    ctrl.trimClip('lead', 10, 90);

    const after = ctrl.getClips()[0]!;
    expect(after).toMatchObject({ inPoint: 10, outPoint: 90, durationFrames: 80 });
  });

  it('trims a linked pair to one length, from the addressed clip speed', () => {
    const video = clipFixture({ startFrame: 20, durationFrames: 100, inPoint: 0, speed: 2 });
    const audio: Clip = {
      ...clipFixture({ id: 'sound', startFrame: 20, durationFrames: 100, inPoint: 0, speed: 2 }),
      type: 'audio',
      trackId: 'a1',
      linkGroupId: 'group',
    };
    const linked = { ...video, linkGroupId: 'group' };
    const ctrl = new EditorController(trimProject(FPS, [linked, audio], 900));

    ctrl.trimClip('lead', 0, 200);

    const clips = ctrl.getClips();
    expect(clips.map((item) => item.durationFrames)).toEqual([100, 100]);
    expect(clips.map((item) => [item.inPoint, item.outPoint])).toEqual([[0, 200], [0, 200]]);
  });

  it('is one undo step under the same label', () => {
    const ctrl = new EditorController(trimProject(FPS, [
      clipFixture({ startFrame: 20, durationFrames: 100, inPoint: 0, speed: 2 }),
    ], 900));

    ctrl.trimClip('lead', 100, 400);

    expect(ctrl.getLastCommandDescription()).toBe('replaceClips');
    expect(ctrl.undo()).toBe(true);
    expect(ctrl.getClips()[0]).toMatchObject({ inPoint: 0, outPoint: 200, durationFrames: 100 });
    expect(ctrl.undo()).toBe(false);
  });

  it('refuses a locked track and an unknown clip without history', () => {
    const locked = new EditorController(trimProject(FPS, [
      clipFixture({ startFrame: 20, durationFrames: 100, inPoint: 0, speed: 2 }),
    ], 900, { locked: true }));
    locked.trimClip('lead', 100, 400);
    expect(locked.getClips()[0]).toMatchObject({ inPoint: 0, outPoint: 200, durationFrames: 100 });
    expect(locked.canUndo()).toBe(false);

    const open = new EditorController(trimProject(FPS, [
      clipFixture({ startFrame: 20, durationFrames: 100, inPoint: 0, speed: 2 }),
    ], 900));
    open.trimClip('ghost', 100, 400);
    expect(open.canUndo()).toBe(false);
  });
});

describe('TrimClipCommand derives the same length from the same window', () => {
  const FPS = 30;

  function commandProject(speed?: number): Project {
    return trimProject(FPS, [
      clipFixture({ startFrame: 20, durationFrames: 100, inPoint: 0, ...(speed ? { speed } : {}) }),
    ], 900);
  }

  it('halves a 2x clip length and restores it on undo', () => {
    const project = commandProject(2);
    const command = new TrimClipCommand('lead', 100, 400);

    const trimmed = command.execute(project);
    const clip = trimmed.timeline.clips[0]!;
    expect(clip).toMatchObject({ inPoint: 100, outPoint: 400, durationFrames: 150 });
    expect(clip.outPoint - clip.inPoint)
      .toBe(Math.round(clip.durationFrames * effectiveSpeed(clip.speed)));

    const restored = command.undo(trimmed).timeline.clips[0]!;
    expect(restored).toMatchObject({ inPoint: 0, outPoint: 200, durationFrames: 100 });
  });

  it('recomputes from the live clip speed instead of one carried in at construction', () => {
    // The constructor is handed the window before it has seen the project, so a
    // length stored there could only be a guess at the speed the clip is
    // trimmed at. A speed set between construction and execution has to be
    // honoured, which is what recomputing in `execute` buys.
    const command = new TrimClipCommand('lead', 0, 200);
    const spedUp = commandProject(2);

    expect(command.execute(spedUp).timeline.clips[0]!.durationFrames).toBe(100);
  });

  it('leaves a speed-1 clip length exactly the window span', () => {
    const command = new TrimClipCommand('lead', 10, 90);

    expect(command.execute(commandProject()).timeline.clips[0]!.durationFrames).toBe(80);
  });
});
