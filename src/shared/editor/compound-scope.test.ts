/**
 * In-place nested-timeline editing (upstream issue #155, slice 2).
 *
 * The controller owns the active-scope path (a breadcrumb stack; empty =
 * main timeline) next to the project it views: every editing op routes
 * through the open scope, while undo stays coherent because commands
 * snapshot the whole project and navigation never touches history.
 * Preview and export always resolve from the root (delivery is
 * deterministic); only the timeline view follows the open scope.
 */
import { describe, it, expect } from 'vitest';
import { EditorController } from './controller';
import { ReplaceClipsCommand } from './commands';
import { MAX_COMPOUND_DEPTH, planNest, resolveRenderTimeline } from './compound';
import { computeAudioPlan } from '../audio/audio-playback';
import { createEmptyProject } from '../types/project';
import type { Clip, Project } from '../types/project';

let clipSeq = 0;

function videoClip(overrides: Partial<Clip> = {}): Clip {
  clipSeq += 1;
  return {
    id: `clip-${clipSeq}`,
    assetId: 'v',
    type: 'video',
    trackId: 'v1',
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

function mediaProject(): Project {
  const project = createEmptyProject();
  project.media = [{
    id: 'v',
    path: 'C:\\media\\take.mp4',
    filename: 'take.mp4',
    type: 'video',
    duration: 900,
    width: 1920,
    height: 1080,
    fileSize: 1000,
    addedAt: '2026-07-29T00:00:00.000Z',
  }];
  return project;
}

/** Two adjacent clips on v1: [0, 60) and [60, 100). */
function twoClipProject(): Project {
  const project = mediaProject();
  project.timeline.clips = [
    videoClip({ id: 'a', startFrame: 0, durationFrames: 60, inPoint: 0, outPoint: 60 }),
    videoClip({ id: 'b', startFrame: 60, durationFrames: 40, inPoint: 10, outPoint: 50 }),
  ];
  return project;
}

/** Controller with [a, b] nested once; returns it with the nest open. */
function controllerInNest(): { ctrl: EditorController; nestId: string; compoundId: string } {
  const ctrl = new EditorController(twoClipProject());
  const receipt = ctrl.nestClips(['a', 'b'], { name: 'Intro' });
  ctrl.openCompoundClip(receipt.compoundClipId);
  return { ctrl, nestId: receipt.timelineId, compoundId: receipt.compoundClipId };
}

describe('scope navigation', () => {
  it('starts at the root with a one-crumb path', () => {
    const ctrl = new EditorController(twoClipProject());
    expect(ctrl.getActiveTimelineId()).toBeNull();
    expect(ctrl.getTimelineBreadcrumbs()).toEqual([{ id: null, name: 'Main' }]);
    expect(ctrl.getActiveTimeline()).toBe(ctrl.getProject().timeline);
  });

  it('opens a compound clip and reports the breadcrumb chain', () => {
    const { ctrl, nestId, compoundId } = controllerInNest();
    expect(ctrl.getActiveTimelineId()).toBe(nestId);
    expect(ctrl.getTimelineBreadcrumbs()).toEqual([
      { id: null, name: 'Main' },
      { id: nestId, name: 'Intro' },
    ]);
    expect(ctrl.getActiveTimeline().clips.map((clip) => clip.id).sort()).toEqual(['a', 'b']);
    expect(compoundId).not.toBe('');
  });

  it('navigates up and jumps to breadcrumb ancestors', () => {
    const { ctrl, nestId } = controllerInNest();
    // Deeper: nest one inner clip so the path has two levels.
    const inner = ctrl.nestClips(['a'], { name: 'Verse' });
    ctrl.openCompoundClip(inner.compoundClipId);
    expect(ctrl.getTimelineBreadcrumbs().map((crumb) => crumb.name)).toEqual([
      'Main', 'Intro', 'Verse',
    ]);

    ctrl.navigateTimelineUp();
    expect(ctrl.getActiveTimelineId()).toBe(nestId);
    ctrl.navigateToScope(null);
    expect(ctrl.getActiveTimelineId()).toBeNull();
    expect(ctrl.navigateTimelineUp()).toEqual([{ id: null, name: 'Main' }]);
  });

  it('refuses breadcrumb jumps off the current path', () => {
    const { ctrl } = controllerInNest();
    expect(() => ctrl.navigateToScope('elsewhere')).toThrow(/not on the current breadcrumb path/);
    expect(ctrl.getActiveTimelineId()).not.toBeNull();
  });

  it('refuses to open dangling, unreachable, and over-deep timelines', () => {
    const ctrl = new EditorController(twoClipProject());
    expect(() => ctrl.openNestedTimeline('ghost')).toThrow(/no longer exists/);
    expect(() => ctrl.openCompoundClip('a')).toThrow(/not a compound/);
    expect(() => ctrl.openCompoundClip('ghost')).toThrow(/not found/);

    // Dangling compound inside the open scope.
    const nested = planNest(twoClipProject(), ['a', 'b']).project;
    const ctrl2 = new EditorController({
      ...nested,
      timeline: {
        ...nested.timeline,
        clips: [...nested.timeline.clips, videoClip({
          id: 'dangling', type: 'compound', compoundTimelineId: 'gone',
          startFrame: 200, durationFrames: 10, inPoint: 0, outPoint: 10,
        })],
      },
    });
    expect(() => ctrl2.openCompoundClip('dangling')).toThrow(/no longer exists/);

    // Orphan cycle (no main-timeline reference): unreachable, never a loop.
    const tracks = twoClipProject().timeline.tracks;
    const cyclic = twoClipProject();
    cyclic.timelines = {
      n1: { tracks, clips: [videoClip({ id: 'to-n2', type: 'compound', compoundTimelineId: 'n2' })], playheadFrame: 0 },
      n2: { tracks, clips: [videoClip({ id: 'to-n1', type: 'compound', compoundTimelineId: 'n1' })], playheadFrame: 0 },
    };
    const ctrl3 = new EditorController(cyclic);
    expect(() => ctrl3.openNestedTimeline('n1')).toThrow(/not reachable/);
  });

  it('opens the depth cap level by level, then refuses one level deeper', () => {
    let project = twoClipProject();
    for (let level = 0; level < MAX_COMPOUND_DEPTH; level += 1) {
      const ids = project.timeline.clips.map((clip) => clip.id);
      project = planNest(project, ids).project;
    }
    const ctrl = new EditorController(project);
    // Eight sequential opens reach depth 8 (distance + subtree stays 8).
    for (let level = 0; level < MAX_COMPOUND_DEPTH; level += 1) {
      const compound = ctrl.getClips().find((clip) => clip.type === 'compound')!;
      ctrl.openCompoundClip(compound.id);
    }
    expect(ctrl.getTimelineBreadcrumbs()).toHaveLength(MAX_COMPOUND_DEPTH + 1);

    // One more level by hand (the planner refuses it): the reachable
    // recursion would be 9, so opening refuses too.
    const ctrl2 = new EditorController(project);
    const tracks = project.timeline.tracks;
    const current = project.timeline.clips[0];
    const deepId = 'hand-deep';
    ctrl2.loadProject({
      ...project,
      timeline: {
        ...project.timeline,
        clips: [videoClip({
          id: 'outer', type: 'compound', compoundTimelineId: deepId,
          startFrame: 0, durationFrames: 100, inPoint: 0, outPoint: 100,
        })],
      },
      timelines: {
        ...project.timelines,
        [deepId]: { tracks, clips: [current], playheadFrame: 0, name: 'Deep' },
      },
    });
    expect(() => ctrl2.openNestedTimeline(deepId)).toThrow(/past the maximum/);
    expect(ctrl2.getActiveTimelineId()).toBeNull();
  });

  it('switching scope is not an undo entry and resets on load', () => {
    const { ctrl } = controllerInNest();
    expect(ctrl.canUndo()).toBe(true);
    expect(ctrl.canRedo()).toBe(false);
    ctrl.navigateTimelineUp();
    ctrl.openCompoundClip(ctrl.getClips()[0].id);
    // Navigation touched history neither way.
    expect(ctrl.canUndo()).toBe(true);
    expect(ctrl.canRedo()).toBe(false);
    ctrl.loadProject(twoClipProject());
    expect(ctrl.getActiveTimelineId()).toBeNull();
    expect(ctrl.canUndo()).toBe(false);
  });
});

describe('editing within the open scope', () => {
  it('moves, trims, splits, and deletes nested clips without touching the root', () => {
    const { ctrl, nestId } = controllerInNest();
    ctrl.moveClip('a', 10);
    expect(ctrl.getClips().find((clip) => clip.id === 'a')?.startFrame).toBe(10);
    // The root still holds exactly the compound clip.
    expect(ctrl.getProject().timeline.clips.map((clip) => clip.id)).toEqual(
      [ctrl.getProject().timeline.clips[0].id],
    );
    expect(ctrl.getProject().timeline.clips[0].type).toBe('compound');

    ctrl.trimClip('b', 20, 50);
    expect(ctrl.getClips().find((clip) => clip.id === 'b')?.inPoint).toBe(20);

    const rightId = ctrl.splitClip('b', 70);
    expect(rightId).not.toBeNull();
    expect(ctrl.getClips()).toHaveLength(3);

    expect(ctrl.removeClips(['a'])).toBe(true);
    expect(ctrl.getClips().map((clip) => clip.id).sort()).toEqual(
      [rightId!, 'b'].sort(),
    );
    // One undo step per op; the scope survives undo.
    expect(ctrl.getActiveTimelineId()).toBe(nestId);
    expect(ctrl.undo()).toBe(true);
    expect(ctrl.getActiveTimelineId()).toBe(nestId);
    expect(ctrl.getClips().some((clip) => clip.id === 'a')).toBe(true);
  });

  it('ripples, marks, and places media inside the nest', () => {
    const { ctrl } = controllerInNest();
    expect(ctrl.rippleDeleteClips(['a'])?.removedClipIds).toContain('a');
    expect(ctrl.getClips().map((clip) => clip.id)).toEqual(['b']);

    const markers = ctrl.changeTimelineMarkers({ creates: [{ name: 'Note', startFrame: 5 }] });
    expect(markers?.created).toHaveLength(1);
    expect(ctrl.getProject().timelines?.[ctrl.getActiveTimelineId()!]?.markers).toHaveLength(1);
    expect(ctrl.getProject().timeline.markers ?? []).toHaveLength(0);

    const trackId = ctrl.addTrack('video', 'Nested V2');
    expect(ctrl.getTracks().some((track) => track.id === trackId)).toBe(true);
    expect(ctrl.getProject().timeline.tracks.some((track) => track.id === trackId)).toBe(false);

    const placed = ctrl.addClip({ assetId: 'v', trackId: 'v1', startFrame: 200, durationFrames: 30 });
    expect(placed).not.toBe('');
    expect(ctrl.getClips().some((clip) => clip.id === placed)).toBe(true);
  });

  it('keeps per-scope playheads while the transport stays root-explicit', () => {
    const { ctrl, nestId } = controllerInNest();
    ctrl.setPlayhead(25);
    expect(ctrl.getActiveTimeline().playheadFrame).toBe(25);
    ctrl.navigateTimelineUp();
    expect(ctrl.getPlayhead()).toBe(0);
    ctrl.setPlayheadInScope(40, null);
    expect(ctrl.getProject().timeline.playheadFrame).toBe(40);
    ctrl.openNestedTimeline(nestId);
    expect(ctrl.getPlayhead()).toBe(25);
    // Root playhead survived the round trip.
    expect(ctrl.getProject().timeline.playheadFrame).toBe(40);
  });

  it('grades and animates nested clips through the same property ops', () => {
    const { ctrl } = controllerInNest();
    const report = ctrl.applyClipProperties(['a'], 'Set opacity', (draft) => {
      draft.opacity = 0.5;
      return true;
    });
    expect(report.changedClipIds).toContain('a');
    expect(ctrl.getProject().timelines?.[ctrl.getActiveTimelineId()!]?.clips
      .find((clip) => clip.id === 'a')?.opacity).toBe(0.5);
    expect(ctrl.undo()).toBe(true);
    expect(ctrl.getClips().find((clip) => clip.id === 'a')?.opacity).toBe(1);
  });
});

describe('cross-scope nest and flatten', () => {
  it('nests inside a nest, naming the scope in the receipt', () => {
    const { ctrl, nestId } = controllerInNest();
    const receipt = ctrl.nestClips(['a'], { name: 'Verse' });
    expect(receipt.scopeTimelineId).toBe(nestId);
    expect(receipt.scopeName).toBe('Intro');
    // The sub-timeline hangs under the right parent: the nest holds the new
    // compound, and the record holds both timelines.
    const inner = ctrl.getActiveTimeline().clips.find((clip) => clip.id === receipt.compoundClipId);
    expect(inner?.compoundTimelineId).toBe(receipt.timelineId);
    expect(Object.keys(ctrl.getProject().timelines ?? {}).sort()).toEqual(
      [nestId, receipt.timelineId].sort(),
    );
    // Rendered content is unchanged by the second nesting (order aside: the
    // inner compound expands in place).
    const resolved = resolveRenderTimeline(ctrl.getProject());
    const shape = resolved.clips
      .map((clip) => [clip.id, clip.startFrame, clip.durationFrames].join(':'))
      .sort();
    expect(shape).toEqual(['a:0:60', 'b:60:40']);
  });

  it('flattens at any depth, deleting only the unreferenced timeline', () => {
    const { ctrl, nestId } = controllerInNest();
    const inner = ctrl.nestClips(['a'], { name: 'Verse' });
    ctrl.openCompoundClip(inner.compoundClipId);
    expect(ctrl.getActiveTimelineId()).toBe(inner.timelineId);
    // Flatten from the holding scope (the nest), not from inside Verse.
    ctrl.navigateTimelineUp();
    const flat = ctrl.flattenCompound(inner.compoundClipId);
    expect(flat.scopeTimelineId).toBe(nestId);
    expect(flat.restoredClipIds).toContain('a');
    expect(ctrl.getProject().timelines?.[inner.timelineId]).toBeUndefined();
    expect(ctrl.getProject().timelines?.[nestId]).toBeDefined();

    ctrl.navigateToScope(null);
    ctrl.flattenCompound(ctrl.getClips()[0].id);
    expect(ctrl.getProject().timelines).toBeUndefined();
    expect(ctrl.getClips().map((clip) => clip.id).sort()).toEqual(['a', 'b']);
  });

  it('keeps a shared timeline alive across scopes until the last reference flattens', () => {
    const ctrl = new EditorController(twoClipProject());
    const first = ctrl.nestClips(['a', 'b']);
    // Copy the root compound, then paste it INSIDE the nest: the pasted
    // compound shares the nest's own timeline id (a self-reference).
    ctrl.copyClips([first.compoundClipId]);
    ctrl.openCompoundClip(first.compoundClipId);
    const pasted = ctrl.pasteClips({ startFrame: 200 });
    expect(pasted).toHaveLength(1);
    // Flattening the root copy must not dangle the in-nest duplicate.
    ctrl.navigateToScope(null);
    ctrl.flattenCompound(first.compoundClipId);
    const survivor = ctrl.getProject().timelines?.[first.timelineId]?.clips
      .find((clip) => clip.id === pasted[0]);
    expect(survivor?.type).toBe('compound');
    expect(resolveRenderTimeline(ctrl.getProject()).clips.length).toBeGreaterThan(0);
  });
});

describe('undo across a scope switch', () => {
  it('edits nested, undoes from the root, navigates back, redoes', () => {
    const { ctrl } = controllerInNest();
    ctrl.moveClip('a', 10);
    expect(ctrl.getClips().find((clip) => clip.id === 'a')?.startFrame).toBe(10);

    // Navigate away, then undo: history is global, the nested move reverts.
    ctrl.navigateToScope(null);
    expect(ctrl.canRedo()).toBe(false);
    expect(ctrl.undo()).toBe(true);
    // Back inside: the clip is where the nest left it, scope intact.
    const nestId = Object.keys(ctrl.getProject().timelines ?? {})[0] ?? null;
    expect(nestId).not.toBeNull();
    ctrl.openNestedTimeline(nestId!);
    expect(ctrl.getClips().find((clip) => clip.id === 'a')?.startFrame).toBe(0);

    expect(ctrl.redo()).toBe(true);
    expect(ctrl.getActiveTimelineId()).toBe(nestId);
    expect(ctrl.getClips().find((clip) => clip.id === 'a')?.startFrame).toBe(10);
  });

  it('coerces the open scope when its timeline is flattened away', () => {
    const { ctrl } = controllerInNest();
    const nestId = ctrl.getActiveTimelineId()!;
    // Flatten from the root while the nest is open: the open scope is gone.
    ctrl.navigateToScope(null);
    ctrl.flattenCompound(ctrl.getClips()[0].id);
    expect(ctrl.getProject().timelines).toBeUndefined();
    // Re-entering the stale scope is impossible; undo restores it coherently.
    expect(() => ctrl.openNestedTimeline(nestId)).toThrow(/no longer exists/);
    expect(ctrl.undo()).toBe(true);
    expect(ctrl.getProject().timelines?.[nestId]).toBeDefined();
    ctrl.openNestedTimeline(nestId);
    expect(ctrl.getClips().map((clip) => clip.id).sort()).toEqual(['a', 'b']);
  });

  it('undoes a scoped edit sanely after its timeline was flattened away', () => {
    const { ctrl, compoundId } = controllerInNest();
    ctrl.moveClip('a', 10);
    // Flatten the nest from the root: the move's timeline no longer exists.
    ctrl.navigateToScope(null);
    ctrl.flattenCompound(compoundId);
    expect(ctrl.getActiveTimelineId()).toBeNull();
    // Undo the flatten first (restores the nest + the moved clip)...
    expect(ctrl.undo()).toBe(true);
    expect(ctrl.getActiveTimelineId()).toBeNull();
    // ...then undo the move inside the restored nest.
    const nestId = Object.keys(ctrl.getProject().timelines ?? {})[0];
    ctrl.openNestedTimeline(nestId);
    expect(ctrl.getClips().find((clip) => clip.id === 'a')?.startFrame).toBe(10);
    expect(ctrl.undo()).toBe(true);
    expect(ctrl.getClips().find((clip) => clip.id === 'a')?.startFrame).toBe(0);
  });

  it('treats scoped commands against a deleted timeline as no-ops', () => {
    // Defensive pin on the command guard: a stale scoped command (e.g. a
    // redo issued after its nest was flattened away) returns the project
    // untouched instead of resurrecting deleted state.
    const { project } = planNest(twoClipProject(), ['a', 'b']);
    const stale = new ReplaceClipsCommand([], 'Stale nested edit', 'gone-timeline');
    expect(stale.execute(project)).toBe(project);
    expect(stale.undo(project)).toBe(project);
  });
});

describe('render-scope rule', () => {
  it('leaves the delivery project untouched by scope navigation', () => {
    const { ctrl } = controllerInNest();
    const before = structuredClone(ctrl.getProject());
    ctrl.navigateToScope(null);
    ctrl.setPlayheadInScope(33, null);
    const afterOpen = structuredClone(ctrl.getProject());
    ctrl.openNestedTimeline(Object.keys(ctrl.getProject().timelines ?? {})[0] ?? '');
    // Only the root playhead moved (an explicit edit); the open scope added nothing.
    expect(ctrl.getProject().timeline.playheadFrame).toBe(33);
    expect({ ...afterOpen, timeline: { ...afterOpen.timeline, playheadFrame: 0 } }).toEqual(
      { ...before, timeline: { ...before.timeline, playheadFrame: 0 } },
    );
    expect(resolveRenderTimeline(ctrl.getProject()).clips).toEqual(
      resolveRenderTimeline(before).clips,
    );
  });

  it('never serializes the open scope; loads always land at the root', () => {
    const { ctrl, nestId } = controllerInNest();
    expect(ctrl.serialize()).not.toContain('activeTimeline');
    const restored = EditorController.deserialize(ctrl.serialize());
    expect(restored.getActiveTimelineId()).toBeNull();
    expect(restored.getProject().timelines?.[nestId]).toBeDefined();
  });

  it('reads explicit scopes without following the ambient one', () => {
    const { ctrl, nestId } = controllerInNest();
    expect(ctrl.getTimelineInScope(null)).toBe(ctrl.getProject().timeline);
    expect(ctrl.getTimelineInScope(nestId).clips.map((clip) => clip.id).sort()).toEqual(['a', 'b']);
    expect(() => ctrl.getTimelineInScope('ghost')).toThrow(/no longer exists/);
  });

  it('hears nested audio through the resolved timeline (preview-audio rule)', () => {
    const project = mediaProject();
    project.media.push({
      id: 'song', path: 'C:\\media\\song.mp3', filename: 'song.mp3', type: 'audio',
      duration: 900, fileSize: 1000, addedAt: '2026-07-29T00:00:00.000Z',
    });
    project.timeline.clips = [
      videoClip({ id: 'a', startFrame: 0, durationFrames: 60, inPoint: 0, outPoint: 60 }),
      { ...videoClip({ id: 'au', type: 'audio', assetId: 'song', trackId: 'a1' }), volume: 0.5 },
    ];
    const ctrl = new EditorController(project);
    ctrl.nestClips(['a', 'au']);
    const view = resolveRenderTimeline(ctrl.getProject());
    const plan = computeAudioPlan({
      clips: view.clips,
      tracks: view.tracks,
      assets: ctrl.getProject().media,
      playbackRate: 1,
      playhead: 10,
      fps: 30,
    });
    expect(plan).toHaveLength(1);
    expect(plan[0].path).toBe('C:\\media\\song.mp3');
    expect(plan[0].volume).toBeCloseTo(0.5, 10);
  });
});
