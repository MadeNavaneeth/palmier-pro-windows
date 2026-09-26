/**
 * The playhead is the view cursor, not an edit.
 *
 * It used to move through a whole-project `ReplaceProjectCommand`, so every
 * scrub frame, transport click and frame step took an undo entry in the
 * 200-entry capped history: Ctrl+Z after a few seconds of preview scrubbing
 * answered "Move playhead" and real edits had been shifted off the bottom of
 * the stack.
 *
 * The notification survives on purpose — the window redraws from it, the
 * renderer mirror pushes it, the main compositor composites that pushed frame,
 * and sibling windows follow it — but it is tagged `playhead`, so a subscriber
 * can tell a cursor move from an edit. `sameProjectExceptPlayhead` is the other
 * half of that contract: it is how a window receiving a sibling's snapshot
 * recognizes one.
 */

import { describe, expect, it } from 'vitest';
import { EditorController, sameProjectExceptPlayhead } from './controller';
import { createEmptyProject } from '../types/project';
import type { Clip, Project } from '../types/project';
import type { StateChangeKind } from './controller';

function videoClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'a',
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
  const project = createEmptyProject('Playhead');
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

/** A controller holding one placed clip, plus the id of that clip. */
function withClip(): { ctrl: EditorController; clipId: string } {
  const ctrl = new EditorController(mediaProject());
  return { ctrl, clipId: ctrl.addClip({ assetId: 'v', trackId: 'v1', startFrame: 0 }) };
}

/** A controller with [a, b] nested once and the nest open, as a compound edit. */
function controllerInNest(): { ctrl: EditorController; nestId: string } {
  const ctrl = new EditorController(mediaProject());
  ctrl.addClip({ assetId: 'v', trackId: 'v1', startFrame: 0 });
  const receipt = ctrl.nestClips([ctrl.getClips()[0].id], { name: 'Intro' });
  ctrl.openCompoundClip(receipt.compoundClipId);
  return { ctrl, nestId: receipt.timelineId };
}

/** Every notification the controller made, with what it said had changed. */
function recordNotifications(ctrl: EditorController): StateChangeKind[] {
  const kinds: StateChangeKind[] = [];
  ctrl.subscribe((_project, kind) => kinds.push(kind));
  return kinds;
}

describe('a playhead move is a view update, not a command', () => {
  it('takes no undo entry, so the stack still holds the last editorial edit', () => {
    const { ctrl } = withClip();

    ctrl.setPlayhead(12);
    ctrl.setPlayheadInScope(48, null);
    ctrl.setPlayhead(96);

    // One entry, and it is the clip: the three moves contributed none.
    expect(ctrl.getLastCommandDescription()).not.toMatch(/playhead/i);
    expect(ctrl.undo()).toBe(true);
    expect(ctrl.getClips()).toHaveLength(0);
    expect(ctrl.undo()).toBe(false);
    expect(ctrl.getPlayhead()).toBe(96);
  });

  it('undo after a playhead move reverts the edit, not the cursor', () => {
    const { ctrl, clipId } = withClip();
    ctrl.setPlayheadInScope(200, null);

    expect(ctrl.undo()).toBe(true);

    expect(ctrl.getClips()).toHaveLength(0);
    // Undoing an edit does not rewind the view; the cursor stays where the user
    // put it, which is the whole point of it not being on the stack.
    expect(ctrl.getPlayhead()).toBe(200);
    expect(ctrl.undo()).toBe(false);

    ctrl.redo();
    expect(ctrl.getClips().map((clip) => clip.id)).toEqual([clipId]);
    expect(ctrl.getPlayhead()).toBe(200);
  });

  it('does not let a long scrub evict a real edit from the capped history', () => {
    // The cap is 200 entries (CommandHistory's default). A drag emits far more
    // moves than that, so as commands the clip below would be long gone.
    const { ctrl } = withClip();
    for (let frame = 0; frame < 250; frame++) ctrl.setPlayheadInScope(frame, null);

    expect(ctrl.getLastCommandDescription()).not.toMatch(/playhead/i);
    expect(ctrl.undo()).toBe(true);
    expect(ctrl.getClips()).toHaveLength(0);
  });

  it('reports a playhead move as a view change and an edit as an edit', () => {
    const { ctrl, clipId } = withClip();
    const kinds = recordNotifications(ctrl);

    ctrl.setPlayhead(30);
    ctrl.setClipBlendMode(clipId, 'multiply');
    ctrl.setPlayheadInScope(90, null);

    expect(kinds).toEqual(['playhead', 'edit', 'playhead']);
  });

  it('leaves updatedAt alone, because the cursor is not authored content', () => {
    const { ctrl } = withClip();
    const before = ctrl.getProject().updatedAt;

    ctrl.setPlayhead(45);
    ctrl.setPlayheadInScope(46, null);

    expect(ctrl.getProject().updatedAt).toBe(before);
  });

  it('does not notify when the frame does not change', () => {
    const { ctrl } = withClip();
    ctrl.setPlayhead(40);
    const kinds = recordNotifications(ctrl);

    ctrl.setPlayhead(40);
    ctrl.setPlayheadInScope(40, null);
    ctrl.setPlayhead(41);
    ctrl.setPlayhead(41);

    // Only the frame that actually moved is worth redrawing, mirroring, or
    // recompositing.
    expect(kinds).toEqual(['playhead']);
  });
});

describe('the playhead value after every path that moves it', () => {
  it('lands ambient, root-explicit and nested moves where they were asked to', () => {
    const { ctrl, nestId } = controllerInNest();

    ctrl.setPlayhead(25);
    expect(ctrl.getActiveTimeline().playheadFrame).toBe(25);
    expect(ctrl.getProject().timeline.playheadFrame).toBe(0);

    // The transport addresses the root explicitly, even inside a nest.
    ctrl.setPlayheadInScope(40, null);
    expect(ctrl.getProject().timeline.playheadFrame).toBe(40);
    expect(ctrl.getActiveTimeline().playheadFrame).toBe(25);

    ctrl.setPlayheadInScope(7, nestId);
    expect(ctrl.getProject().timelines?.[nestId]?.playheadFrame).toBe(7);
    expect(ctrl.getPlayhead()).toBe(7);

    // Scope changes leave each timeline's own playhead alone.
    ctrl.navigateTimelineUp();
    expect(ctrl.getPlayhead()).toBe(40);
    ctrl.openNestedTimeline(nestId);
    expect(ctrl.getPlayhead()).toBe(7);
  });

  it('clamps a frame from a hostile caller', () => {
    const { ctrl } = withClip();

    ctrl.setPlayhead(-10);
    expect(ctrl.getPlayhead()).toBe(0);

    ctrl.setPlayhead(12.9);
    expect(ctrl.getPlayhead()).toBe(12);

    ctrl.setPlayheadInScope(Number.NaN, null);
    expect(ctrl.getProject().timeline.playheadFrame).toBe(0);
  });

  it('refuses a scope that is not there rather than inventing one', () => {
    const { ctrl } = withClip();
    expect(() => ctrl.setPlayheadInScope(30, 'no-such-nest')).toThrow(/no longer exists/);
  });
});

describe('sameProjectExceptPlayhead', () => {
  it('sees a playhead-only difference as no difference at all', () => {
    const before = mediaProject();
    const after: Project = {
      ...before,
      timeline: { ...before.timeline, playheadFrame: 120 },
    };
    expect(sameProjectExceptPlayhead(before, after)).toBe(true);
    expect(sameProjectExceptPlayhead(after, before)).toBe(true);
  });

  it('sees a playhead move in a nested timeline as no difference either', () => {
    const ctrl = new EditorController(mediaProject());
    ctrl.addClip({ assetId: 'v', trackId: 'v1', startFrame: 0 });
    const nestId = ctrl.nestClips([ctrl.getClips()[0].id], { name: 'Intro' }).timelineId;
    const before = ctrl.getProject();

    ctrl.setPlayheadInScope(9, nestId);
    expect(sameProjectExceptPlayhead(before, ctrl.getProject())).toBe(true);
  });

  it('sees an edit, a settings change and a media change as differences', () => {
    const before = mediaProject();

    const clipEdit: Project = {
      ...before,
      timeline: {
        ...before.timeline,
        clips: [videoClip()],
      },
    };
    expect(sameProjectExceptPlayhead(before, clipEdit)).toBe(false);

    const settingsEdit: Project = {
      ...before,
      settings: { ...before.settings, width: 1280 },
    };
    expect(sameProjectExceptPlayhead(before, settingsEdit)).toBe(false);

    const mediaEdit: Project = { ...before, media: [...before.media] };
    mediaEdit.media[0] = { ...mediaEdit.media[0], path: 'C:\\media\\other.mp4' };
    expect(sameProjectExceptPlayhead(before, mediaEdit)).toBe(false);
  });

  it('compares by value, the way the snapshots travel between windows', () => {
    const before = mediaProject();
    // A payload that made the round trip through JSON.parse: a key the sender
    // held as `undefined` is simply absent, and the keys are re-inserted in
    // whatever order the sender's object had.
    const after = JSON.parse(JSON.stringify({
      ...before,
      timeline: { ...before.timeline, playheadFrame: 30, markers: undefined },
    })) as Project;
    const { name, ...reordered } = after.timeline;
    after.timeline = { ...reordered, name } as typeof after.timeline;
    expect(after.timeline.markers).toBeUndefined();

    expect(sameProjectExceptPlayhead(before, after)).toBe(true);
  });

  it('answers for the same object trivially', () => {
    const project = mediaProject();
    expect(sameProjectExceptPlayhead(project, project)).toBe(true);
  });
});
