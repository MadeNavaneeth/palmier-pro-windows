/**
 * The export panel's caption gate across compound clips.
 *
 * `hasTitles` exists so a project with no title text never writes an empty
 * `.vtt` beside its video. It read `project.timeline.clips`, which cannot see
 * a title inside a compound clip: a project whose ONLY title was nested read as
 * "no titles", so the panel both hid the checkbox and sent
 * `exportCaptions: false` — and the user got a video with the title burned in
 * and no caption file at all, silently.
 *
 * The gate now asks the resolved render timeline, the same one the export
 * graph is built from, so the sidecar tracks what is actually on screen.
 */
import { describe, it, expect } from 'vitest';
import { createEmptyProject } from '../../shared/types/project';
import type { Clip, Project, Timeline, Track } from '../../shared/types/project';
import { resolveRenderTimeline } from '../../shared/editor/compound';
import { hasCaptionTitles } from './ExportDialog';

const VIDEO_PATH = 'X:/media/clip.mp4';

function track(id: string, order: number): Track {
  return { id, name: id.toUpperCase(), type: 'video', locked: false, visible: true, syncLocked: true, order };
}

let clipSeq = 0;
function clip(overrides: Partial<Clip> = {}): Clip {
  clipSeq += 1;
  return {
    id: `clip-${clipSeq}`,
    assetId: 'v',
    type: 'video',
    trackId: 'v1',
    startFrame: 0,
    durationFrames: 30,
    inPoint: 0,
    outPoint: 30,
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

function compound(overrides: Partial<Clip> & { timelineId: string }): Clip {
  const { timelineId, ...rest } = overrides;
  return clip({
    type: 'compound',
    assetId: '__compound__',
    trackId: 'v2',
    inPoint: 0,
    outPoint: 30,
    durationFrames: 30,
    label: 'Nest',
    ...rest,
    compoundTimelineId: timelineId,
  });
}

function title(id: string, text: string, overrides: Partial<Clip> = {}): Clip {
  return clip({ id, type: 'title', assetId: '__title__', trackId: 't1', inPoint: 0, outPoint: 30, text, ...overrides });
}

function nested(clips: Clip[], name: string): Timeline {
  return { tracks: [track('v1', 1), track('t1', 2)], clips, playheadFrame: 0, name };
}

/** Empty main timeline with a video bed, a title track, and a nest track. */
function baseProject(): Project {
  const project = createEmptyProject();
  project.media = [{
    id: 'v', path: VIDEO_PATH, filename: 'clip.mp4', type: 'video', duration: 600,
    width: 1920, height: 1080, fileSize: 1, addedAt: '2026-01-01T00:00:00.000Z',
  }];
  project.timeline.tracks = [track('v1', 1), track('t1', 2), track('v2', 3)];
  project.timeline.clips = [clip({ id: 'bed', startFrame: 0, durationFrames: 60, inPoint: 0, outPoint: 60 })];
  return project;
}

describe('export panel caption gate', () => {
  it('counts a title whose only home is inside a compound', () => {
    const project = baseProject();
    project.timeline.clips.push(
      compound({ id: 'nest', timelineId: 'n1', startFrame: 100 }),
    );
    project.timelines = { n1: nested([title('inner-title', 'Nested caption', { startFrame: 10 })], 'Nest') };

    // The precondition this gate is really asking: the render draws it.
    expect(resolveRenderTimeline(project).clips.some((c) => c.type === 'title')).toBe(true);
    expect(hasCaptionTitles(project)).toBe(true);
  });

  it('counts a title nested two levels deep', () => {
    const project = baseProject();
    project.timeline.clips.push(compound({ id: 'outer', timelineId: 'n1', startFrame: 100 }));
    project.timelines = {
      n1: nested([compound({ id: 'inner', timelineId: 'n2', trackId: 'v1', startFrame: 0, outPoint: 20, durationFrames: 20 })], 'Outer'),
      n2: nested([title('deep-title', 'Deep caption', { startFrame: 5, outPoint: 10, durationFrames: 10 })], 'Inner'),
    };

    expect(hasCaptionTitles(project)).toBe(true);
  });

  it('counts a top-level title and a nested title', () => {
    const project = baseProject();
    project.timeline.clips.push(
      title('top-title', 'Top caption', { startFrame: 10 }),
      compound({ id: 'nest', timelineId: 'n1', startFrame: 100 }),
    );
    project.timelines = { n1: nested([title('inner-title', 'Nested caption', { startFrame: 10 })], 'Nest') };

    expect(hasCaptionTitles(project)).toBe(true);
  });

  it('reports no titles for a project with none anywhere', () => {
    const project = baseProject();
    project.timeline.clips.push(compound({ id: 'nest', timelineId: 'n1', startFrame: 100 }));
    project.timelines = { n1: nested([clip({ id: 'inner-video' })], 'Nest') };

    // False is what suppresses the sidecar; unchanged for a title-less project.
    expect(hasCaptionTitles(project)).toBe(false);
  });

  it('reports no titles for an empty project', () => {
    expect(hasCaptionTitles(createEmptyProject())).toBe(false);
  });

  it('reports no titles when every title has no text', () => {
    const project = baseProject();
    project.timeline.clips.push(title('blank', '', { startFrame: 10 }));

    expect(hasCaptionTitles(project)).toBe(false);
  });

  it('ignores a title the render cannot reach', () => {
    // A dangling compound resolves to nothing, so nothing is drawn and the
    // gate must not offer a sidecar for it.
    const project = baseProject();
    project.timeline.clips.push(compound({ id: 'nest', timelineId: 'gone', startFrame: 100 }));
    project.timelines = { n1: nested([title('inner-title', 'Unreachable')], 'Orphan') };

    expect(hasCaptionTitles(project)).toBe(false);
  });

  it('agrees with the panel request it gates: captions are asked for iff asked', () => {
    // The panel sends `exportCaptions && hasTitles`. Restated here so the gate
    // and the request it drives are pinned together, not just the predicate.
    const withNested = baseProject();
    withNested.timeline.clips.push(compound({ id: 'nest', timelineId: 'n1', startFrame: 100 }));
    withNested.timelines = { n1: nested([title('inner-title', 'Nested caption', { startFrame: 10 })], 'Nest') };

    const without = baseProject();
    without.timeline.clips.push(compound({ id: 'nest', timelineId: 'n1', startFrame: 100 }));
    without.timelines = { n1: nested([clip({ id: 'inner-video' })], 'Nest') };

    const request = (project: Project, userOptIn: boolean) => userOptIn && hasCaptionTitles(project);
    expect(request(withNested, true)).toBe(true);
    expect(request(without, true)).toBe(false);
    expect(request(withNested, false)).toBe(false);
  });
});
