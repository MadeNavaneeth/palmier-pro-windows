/**
 * Compound clips / nested sequences (upstream issue #155, slice 1).
 *
 * No upstream implementation exists at b4b1333 (verified by the orchestrator),
 * so this covers the original Windows design in shared/editor/compound.ts:
 * sanitize/narrow on load, nest/flatten round trips as one undo step each,
 * cycle/depth/dangling refusals, recursive-render equivalence with the
 * flattened timeline, and project-frame timebase mapping (including trims
 * and absolute-frame keyframe rebasing).
 */
import { describe, it, expect } from 'vitest';
import { EditorController } from './controller';
import { diagnoseTimeline } from './diagnostics';
import {
  COMPOUND_ASSET_ID,
  MAX_COMPOUND_DEPTH,
  narrowCompoundClip,
  planFlatten,
  planNest,
  resolveRenderTimeline,
  sanitizeCompoundTimelineId,
  validateCompoundGraph,
  withNarrowedCompounds,
} from './compound';
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

function sortedRenderClips(project: Project): Clip[] {
  return [...resolveRenderTimeline(project).clips]
    .sort((a, b) => a.startFrame - b.startFrame || (a.id < b.id ? -1 : 1));
}

/**
 * Render clips with the nest namespace stripped from track ids
 * (`<compound-id>/…#<track-id>` → `<track-id>`): namespacing preserves the
 * nested layer order through the flatten, so geometry/timing equivalence
 * with a flattened timeline compares modulo that prefix.
 */
function denamespaced(clips: Clip[]): Clip[] {
  return clips
    .map((clip) => {
      const hash = clip.trackId.lastIndexOf('#');
      return hash === -1 ? clip : { ...clip, trackId: clip.trackId.slice(hash + 1) };
    })
    .sort((a, b) => a.startFrame - b.startFrame || (a.id < b.id ? -1 : 1));
}

describe('sanitizeCompoundTimelineId', () => {
  it('keeps a non-empty string and drops everything else', () => {
    expect(sanitizeCompoundTimelineId('abc')).toBe('abc');
    expect(sanitizeCompoundTimelineId('')).toBeUndefined();
    expect(sanitizeCompoundTimelineId(42)).toBeUndefined();
    expect(sanitizeCompoundTimelineId(null)).toBeUndefined();
    expect(sanitizeCompoundTimelineId(undefined)).toBeUndefined();
  });
});

describe('narrowCompoundClip', () => {
  it('strips the field from non-compound clips and keeps clean ones untouched', () => {
    const plain = videoClip({ id: 'plain' });
    expect(narrowCompoundClip(plain)).toBe(plain);
    const tainted = videoClip({ id: 'tainted', compoundTimelineId: 'x' as unknown as undefined });
    const narrowed = narrowCompoundClip(tainted);
    expect(narrowed).not.toBe(tainted);
    expect('compoundTimelineId' in narrowed).toBe(false);
  });

  it('keeps valid and dangling-but-well-formed references, drops hostile ones', () => {
    const valid = videoClip({ id: 'c', type: 'compound', compoundTimelineId: 'nested-1' });
    expect(narrowCompoundClip(valid)).toBe(valid);
    // Dangling is kept: render skips it and diagnostics reports it, so a load
    // never destroys meaning.
    const dangling = videoClip({ id: 'd', type: 'compound', compoundTimelineId: 'gone' });
    expect(narrowCompoundClip(dangling)).toBe(dangling);
    const hostile = videoClip({ id: 'e', type: 'compound', compoundTimelineId: 42 as unknown as string });
    const narrowed = narrowCompoundClip(hostile);
    expect('compoundTimelineId' in narrowed).toBe(false);
  });
});

describe('withNarrowedCompounds', () => {
  it('narrows hostile fields on the main and nested timelines', () => {
    const project = twoClipProject();
    project.timeline.clips = [
      videoClip({ id: 'tainted', compoundTimelineId: 'x' as unknown as undefined }),
    ];
    project.timelines = {
      nested: {
        tracks: project.timeline.tracks,
        clips: [videoClip({ id: 'inner-tainted', compoundTimelineId: 7 as unknown as string })],
        playheadFrame: 0,
      },
    };
    const narrowed = withNarrowedCompounds(project);
    expect(narrowed).not.toBe(project);
    expect('compoundTimelineId' in narrowed.timeline.clips[0]).toBe(false);
    expect('compoundTimelineId' in narrowed.timelines!.nested.clips[0]).toBe(false);
  });

  it('returns the project untouched when clean', () => {
    const project = twoClipProject();
    expect(withNarrowedCompounds(project)).toBe(project);
  });
});

describe('planNest', () => {
  it('moves clips verbatim into a sub-timeline behind one compound clip', () => {
    const project = twoClipProject();
    const { project: next, receipt } = planNest(project, ['a', 'b'], { name: 'Intro' });
    expect(receipt.timelineName).toBe('Intro');
    expect(receipt.nestedClipIds).toEqual(expect.arrayContaining(['a', 'b']));
    expect(receipt.startFrame).toBe(0);
    expect(receipt.durationFrames).toBe(100);
    expect(next.timeline.clips).toHaveLength(1);

    const compound = next.timeline.clips[0];
    expect(compound.type).toBe('compound');
    expect(compound.assetId).toBe(COMPOUND_ASSET_ID);
    expect(compound.compoundTimelineId).toBe(receipt.timelineId);
    expect(compound.startFrame).toBe(0);
    expect(compound.durationFrames).toBe(100);
    expect(compound.inPoint).toBe(0);
    expect(compound.outPoint).toBe(100);

    const nested = next.timelines![receipt.timelineId];
    expect(nested.name).toBe('Intro');
    expect(nested.clips.map((clip) => clip.id).sort()).toEqual(['a', 'b']);
    // Inner content is rebased to the nested origin.
    expect(nested.clips.find((clip) => clip.id === 'a')?.startFrame).toBe(0);
    expect(nested.clips.find((clip) => clip.id === 'b')?.startFrame).toBe(60);
  });

  it('rebases absolute-frame keyframe tracks with the move', () => {
    const project = mediaProject();
    project.timeline.clips = [
      videoClip({
        id: 'k',
        startFrame: 40,
        durationFrames: 60,
        inPoint: 0,
        outPoint: 60,
        motionX: [{ frame: 40, value: 0 }, { frame: 100, value: 80 }],
      }),
    ];
    const { project: next, receipt } = planNest(project, ['k']);
    const inner = next.timelines![receipt.timelineId].clips[0];
    expect(inner.startFrame).toBe(0);
    expect(inner.motionX).toEqual([{ frame: 0, value: 0 }, { frame: 60, value: 80 }]);
    // Resolution shifts them back to absolute main-timeline frames.
    const resolved = resolveRenderTimeline(next).clips[0];
    expect(resolved.motionX).toEqual([{ frame: 40, value: 0 }, { frame: 100, value: 80 }]);
    expect(resolved.startFrame).toBe(40);
  });

  it('auto-includes linked partners and refuses bad selections', () => {
    const project = mediaProject();
    project.timeline.clips = [
      videoClip({ id: 'v', startFrame: 0, durationFrames: 60, inPoint: 0, outPoint: 60, linkGroupId: 'g' }),
      { ...videoClip({ id: 'au', type: 'audio', trackId: 'a1' }), linkGroupId: 'g' },
    ];
    const { receipt } = planNest(project, ['v']);
    expect(receipt.nestedClipIds).toEqual(expect.arrayContaining(['v', 'au']));

    expect(() => planNest(project, [])).toThrow(/at least one clip/);
    expect(() => planNest(project, ['ghost'])).toThrow(/not found/);
  });

  it('refuses clips on locked tracks and over-deep nests', () => {
    const project = twoClipProject();
    project.timeline.tracks = project.timeline.tracks.map((track) =>
      (track.id === 'v1' ? { ...track, locked: true } : track));
    expect(() => planNest(project, ['a'])).toThrow(/locked/);
  });

  it('nests compounds up to the depth cap, then refuses', () => {
    let project = twoClipProject();
    for (let level = 0; level < MAX_COMPOUND_DEPTH; level += 1) {
      const ids = project.timeline.clips.map((clip) => clip.id);
      project = planNest(project, ids).project;
    }
    const ids = project.timeline.clips.map((clip) => clip.id);
    expect(() => planNest(project, ids)).toThrow(/past the maximum/);
  });

  it('truncates over-long sequence names', () => {
    const { receipt } = planNest(twoClipProject(), ['a'], { name: `x`.repeat(200) });
    expect(receipt.timelineName).toHaveLength(120);
  });
});

describe('planFlatten', () => {
  it('restores nested content at its rendered position', () => {
    const nested = planNest(twoClipProject(), ['a', 'b']).project;
    const compoundId = nested.timeline.clips[0].id;
    const { project: flat, receipt } = planFlatten(nested, compoundId);
    expect(receipt.compoundClipId).toBe(compoundId);
    expect(receipt.restoredClipIds).toEqual(expect.arrayContaining(['a', 'b']));
    expect(flat.timelines).toBeUndefined();
    const byId = new Map(flat.timeline.clips.map((clip) => [clip.id, clip]));
    expect(byId.get('a')?.startFrame).toBe(0);
    expect(byId.get('b')?.startFrame).toBe(60);
    // Round trip is exact (clip order aside: flatten appends at the end).
    const before = [...twoClipProject().timeline.clips].sort((a, b) => (a.id < b.id ? -1 : 1));
    const after = [...flat.timeline.clips].sort((a, b) => (a.id < b.id ? -1 : 1));
    expect(after).toEqual(before);
  });

  it('keeps the nested timeline while another compound still references it', () => {
    const ctrl = new EditorController(twoClipProject());
    const first = ctrl.nestClips(['a', 'b']);
    ctrl.copyClips([first.compoundClipId]);
    const pasted = ctrl.pasteClips({ startFrame: 200 });
    expect(pasted).toHaveLength(1);
    // Both compounds share one timeline id.
    const ids = new Set(ctrl.getClips().map((clip) => clip.compoundTimelineId));
    expect(ids.size).toBe(1);

    ctrl.flattenCompound(first.compoundClipId);
    const survivor = ctrl.getClips().find((clip) => clip.type === 'compound');
    expect(survivor).toBeDefined();
    expect(ctrl.getProject().timelines?.[survivor!.compoundTimelineId!]).toBeDefined();
    // The survivor still renders its content.
    expect(resolveRenderTimeline(ctrl.getProject()).clips.length).toBeGreaterThan(0);
  });

  it('refuses unknown, non-compound, dangling, and window-invalid compounds', () => {
    const nested = planNest(twoClipProject(), ['a', 'b']).project;
    expect(() => planFlatten(nested, 'ghost')).toThrow(/not found/);
    expect(() => planFlatten(twoClipProject(), 'a')).toThrow(/not a compound/);

    const dangling: Project = {
      ...twoClipProject(),
      timeline: {
        ...twoClipProject().timeline,
        clips: [videoClip({ id: 'c', type: 'compound', compoundTimelineId: 'gone' })],
      },
    };
    expect(() => planFlatten(dangling, 'c')).toThrow(/no longer exists/);

    const broken: Project = structuredClone(nested);
    const compound = broken.timeline.clips[0];
    compound.outPoint = compound.inPoint;
    compound.durationFrames = 0;
    expect(() => planFlatten(broken, compound.id)).toThrow(/invalid nested window/);
  });
});

describe('nest/flatten undo discipline', () => {
  it('nests as exactly one undo step', () => {
    const ctrl = new EditorController(twoClipProject());
    expect(ctrl.canUndo()).toBe(false);
    const before = structuredClone(ctrl.getProject());
    ctrl.nestClips(['a', 'b']);
    expect(ctrl.getClips()).toHaveLength(1);
    expect(ctrl.canUndo()).toBe(true);
    expect(ctrl.undo()).toBe(true);
    expect(ctrl.canUndo()).toBe(false);
    expect(ctrl.getProject().timeline.clips).toEqual(before.timeline.clips);
    expect(ctrl.getProject().timelines).toEqual(before.timelines);
  });

  it('flattens as exactly one undo step', () => {
    const nested = planNest(twoClipProject(), ['a', 'b']).project;
    const ctrl = new EditorController(nested);
    const compoundId = ctrl.getClips()[0].id;
    ctrl.flattenCompound(compoundId);
    expect(ctrl.getClips()).toHaveLength(2);
    expect(ctrl.undo()).toBe(true);
    expect(ctrl.canUndo()).toBe(false);
    expect(ctrl.getClips()).toHaveLength(1);
    expect(ctrl.getClips()[0].id).toBe(compoundId);
  });

  it('leaves history untouched when nest is refused', () => {
    const ctrl = new EditorController(twoClipProject());
    expect(() => ctrl.nestClips(['ghost'])).toThrow();
    expect(ctrl.canUndo()).toBe(false);
  });
});

describe('validateCompoundGraph', () => {
  it('accepts projects without compounds', () => {
    expect(validateCompoundGraph(twoClipProject())).toEqual([]);
  });

  it('reports dangling references', () => {
    const project = twoClipProject();
    project.timeline.clips = [videoClip({ id: 'c', type: 'compound', compoundTimelineId: 'gone' })];
    const errors = validateCompoundGraph(project);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('gone');
  });

  it('reports a missing reference on a compound clip', () => {
    const project = twoClipProject();
    project.timeline.clips = [videoClip({ id: 'c', type: 'compound' })];
    expect(validateCompoundGraph(project)[0]).toContain('no nested timeline reference');
  });

  it('reports direct and transitive cycles', () => {
    const tracks = twoClipProject().timeline.tracks;
    const project = twoClipProject();
    project.timelines = {
      n1: {
        tracks,
        clips: [videoClip({ id: 'to-n2', type: 'compound', compoundTimelineId: 'n2' })],
        playheadFrame: 0,
      },
      n2: {
        tracks,
        clips: [videoClip({ id: 'to-n1', type: 'compound', compoundTimelineId: 'n1' })],
        playheadFrame: 0,
      },
    };
    project.timeline.clips = [videoClip({ id: 'c', type: 'compound', compoundTimelineId: 'n1' })];
    const errors = validateCompoundGraph(project);
    expect(errors.some((error) => error.includes('cycle'))).toBe(true);
  });

  it('reports chains past the depth cap', () => {
    let project = twoClipProject();
    for (let level = 0; level < MAX_COMPOUND_DEPTH; level += 1) {
      const ids = project.timeline.clips.map((clip) => clip.id);
      project = planNest(project, ids).project;
    }
    // One more level by hand (the planner refuses it): splice a compound
    // around the current one.
    const tracks = project.timeline.tracks;
    const innerId = 'hand-deep';
    const outer = videoClip({
      id: 'outer',
      type: 'compound',
      compoundTimelineId: innerId,
      startFrame: 0,
      durationFrames: 100,
      inPoint: 0,
      outPoint: 100,
    });
    const current = project.timeline.clips[0];
    project = {
      ...project,
      timeline: { ...project.timeline, clips: [outer] },
      timelines: {
        ...project.timelines,
        [innerId]: { tracks, clips: [current], playheadFrame: 0, name: 'Deep' },
      },
    };
    const errors = validateCompoundGraph(project);
    expect(errors.some((error) => error.includes('past the maximum'))).toBe(true);
  });
});

describe('resolveRenderTimeline', () => {
  it('returns the timeline untouched when there is nothing nested', () => {
    const project = twoClipProject();
    expect(resolveRenderTimeline(project)).toBe(project.timeline);
  });

  it('renders a compound exactly like its flattened content', () => {
    const nested = planNest(twoClipProject(), ['a', 'b']).project;
    const compoundId = nested.timeline.clips[0].id;
    const flat = planFlatten(nested, compoundId).project;
    expect(denamespaced(resolveRenderTimeline(nested).clips))
      .toEqual(denamespaced(resolveRenderTimeline(flat).clips));
    // Layer order and visibility survive the namespacing too (distinct
    // shapes: the resolved nest carries both the emptied main track and its
    // namespaced inner twin, and consumers key tracks by id and sort by
    // `order`, not array position).
    const trackShape = (project: Project) => [...new Set(
      resolveRenderTimeline(project)
        .tracks.map((track) => [track.order, track.visible, track.type].join(':')),
    )].sort();
    expect(trackShape(nested)).toEqual(trackShape(flat));
  });

  it('maps nested frames through the compound window, including trims', () => {
    const nested = planNest(twoClipProject(), ['a', 'b']).project;
    const compound = nested.timeline.clips[0];
    // Trim 10 frames off the head: the window slides, content stays put.
    const trimmed: Project = {
      ...nested,
      timeline: {
        ...nested.timeline,
        clips: [{
          ...compound,
          startFrame: compound.startFrame + 10,
          durationFrames: compound.durationFrames - 10,
          inPoint: compound.inPoint + 10,
        }],
      },
    };
    const resolved = sortedRenderClips(trimmed);
    // Clip 'a' loses its first 10 frames; clip 'b' is untouched.
    expect(resolved.find((clip) => clip.id === 'a')?.startFrame).toBe(10);
    expect(resolved.find((clip) => clip.id === 'a')?.durationFrames).toBe(50);
    expect(resolved.find((clip) => clip.id === 'a')?.inPoint).toBe(10);
    expect(resolved.find((clip) => clip.id === 'b')?.startFrame).toBe(60);
  });

  it('composes the outer transform onto nested content', () => {
    const project = mediaProject();
    project.timeline.clips = [videoClip({ id: 'inner', x: 10, y: 20, scaleX: 2, opacity: 0.5 })];
    const nested = planNest(project, ['inner']).project;
    const composed: Project = {
      ...nested,
      timeline: {
        ...nested.timeline,
        clips: nested.timeline.clips.map((clip) => ({
          ...clip,
          x: 5,
          y: 7,
          scaleX: 3,
          scaleY: 3,
          rotation: 90,
          opacity: 0.5,
        })),
      },
    };
    const resolved = resolveRenderTimeline(composed).clips[0];
    expect(resolved.x).toBe(15);
    expect(resolved.y).toBe(27);
    expect(resolved.scaleX).toBe(6);
    expect(resolved.rotation).toBe(90);
    expect(resolved.opacity).toBeCloseTo(0.25, 10);
  });

  it('resolves cycles, dangling references, and over-deep chains to nothing', () => {
    const tracks = twoClipProject().timeline.tracks;
    const dangling = twoClipProject();
    dangling.timeline.clips = [videoClip({ id: 'c', type: 'compound', compoundTimelineId: 'gone' })];
    expect(resolveRenderTimeline(dangling).clips).toEqual([]);

    const cyclic = twoClipProject();
    cyclic.timelines = {
      n1: {
        tracks,
        clips: [videoClip({ id: 'to-n2', type: 'compound', compoundTimelineId: 'n2' })],
        playheadFrame: 0,
      },
      n2: {
        tracks,
        clips: [videoClip({ id: 'to-n1', type: 'compound', compoundTimelineId: 'n1' })],
        playheadFrame: 0,
      },
    };
    cyclic.timeline.clips = [videoClip({ id: 'c', type: 'compound', compoundTimelineId: 'n1' })];
    expect(resolveRenderTimeline(cyclic).clips).toEqual([]);

    // A window-invalid compound (out before in) renders nothing, not a throw.
    const broken = planNest(twoClipProject(), ['a', 'b']).project;
    broken.timeline.clips[0].outPoint = broken.timeline.clips[0].inPoint;
    expect(resolveRenderTimeline(broken).clips).toEqual([]);
  });

  it('keeps other clips rendering when one compound dangles', () => {
    const project = twoClipProject();
    project.timeline.clips = [
      ...project.timeline.clips,
      videoClip({
        id: 'ghost',
        type: 'compound',
        compoundTimelineId: 'gone',
        startFrame: 200,
        durationFrames: 10,
        inPoint: 0,
        outPoint: 10,
      }),
    ];
    const resolved = sortedRenderClips(project).map((clip) => clip.id);
    expect(resolved).toEqual(['a', 'b']);
  });
});

describe('compound persistence and load narrowing', () => {
  it('round-trips nested timelines through JSON unchanged', () => {
    const nested = planNest(twoClipProject(), ['a', 'b'], { name: 'Intro' }).project;
    const restored = EditorController.deserialize(JSON.stringify(nested)).getProject();
    expect(restored.timelines).toEqual(nested.timelines);
    expect(restored.timeline.clips).toEqual(nested.timeline.clips);
  });

  it('narrows hostile compound fields on load instead of throwing', () => {
    const nested = planNest(twoClipProject(), ['a', 'b']).project;
    const hostile = structuredClone(nested);
    hostile.timeline.clips[0].compoundTimelineId = 42 as unknown as string;
    const ctrl = new EditorController(hostile);
    expect('compoundTimelineId' in ctrl.getClips()[0]).toBe(false);
    // A narrowed compound resolves to nothing rather than crashing render.
    expect(resolveRenderTimeline(ctrl.getProject()).clips).toEqual([]);
  });
});

describe('compound diagnostics', () => {
  it('does not flag a healthy compound as missing media', () => {
    const nested = planNest(twoClipProject(), ['a', 'b']).project;
    // The inner clips still reference library media, so the only question is
    // whether the compound itself false-positives.
    const codes = diagnoseTimeline(nested).map((issue) => issue.code);
    expect(codes).not.toContain('missing-media');
    expect(codes).not.toContain('compound-invalid');
  });

  it('reports a dangling compound reference as a compound error', () => {
    const project = twoClipProject();
    project.timeline.clips = [videoClip({ id: 'c', type: 'compound', compoundTimelineId: 'gone' })];
    const issues = diagnoseTimeline(project);
    const flagged = issues.filter((issue) => issue.code === 'compound-invalid');
    expect(flagged).toHaveLength(1);
    expect(flagged[0].severity).toBe('error');
    expect(flagged[0].message).toContain('gone');
  });
});

describe('compound trim headroom', () => {
  it('caps right-edge extension at the nested content end', () => {
    const ctrl = new EditorController(planNest(twoClipProject(), ['a', 'b']).project);
    const compoundId = ctrl.getClips()[0].id;
    // Nested content is 100 frames; the compound already spans all of it.
    expect(ctrl.trimClipEdge(compoundId, 'right', 50)).toBeNull();
    expect(ctrl.getClips()[0].durationFrames).toBe(100);
  });
});
