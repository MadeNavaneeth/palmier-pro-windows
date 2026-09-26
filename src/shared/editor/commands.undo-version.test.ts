/**
 * Undo must not resurrect a project that no longer exists.
 *
 * A command captures its inverse state when it first executes, so that capture
 * only describes the project while nothing else has changed it. Main's history
 * holds only agent commands, and the renderer's authoritative project arrives as
 * a wholesale write that goes through no command at all — so a user edit
 * followed by an agent undo used to silently revert the user's work (a
 * `SetClipPropertiesCommand` restoring stale `previousClips`) or replace the
 * whole document (a `ReplaceProjectCommand` returning its pre-edit `previousProject`),
 * both with a success receipt.
 *
 * `CommandHistory` therefore versions its entries against a counter of writes it
 * did not make, and refuses rather than guessing. These tests pin the refusal, the
 * paths that must advance the counter, the ones deliberately exempted, and the
 * fact that the renderer's own local undo is untouched.
 */
import { describe, expect, it } from 'vitest';
import { EditorController } from './controller';
import { CommandHistory, AddTrackCommand } from './commands';
import type { Clip, Project } from '../types/project';

/** A controller with one media asset and one clip, the shape these tests edit. */
function seeded(): { editor: EditorController; clipId: string } {
  const editor = new EditorController();
  editor.addMedia({
    id: 'm',
    path: 'X:/media/m.mp4',
    filename: 'm.mp4',
    type: 'video',
    duration: 300,
    width: 1920,
    height: 1080,
    fileSize: 1,
    addedAt: '2026-01-01T00:00:00.000Z',
  });
  const clipId = editor.addClip({ assetId: 'm', trackId: 'v1', startFrame: 0, durationFrames: 60 });
  return { editor, clipId };
}

const clip = (editor: EditorController): Record<string, unknown> =>
  editor.getProject().timeline.clips[0] as unknown as Record<string, unknown>;

/** What the renderer->main mirror does: replace the project, no command. */
function mirrorPush(editor: EditorController, edit: (c: Clip) => Clip): void {
  const project = editor.getProject();
  editor.setProjectFromMirror({
    ...project,
    timeline: { ...project.timeline, clips: project.timeline.clips.map(edit) },
  });
}

describe('undo refuses an entry whose captured inverse state is stale', () => {
  it('a mirror write between apply and undo blocks the undo and keeps the user edit', () => {
    const { editor, clipId } = seeded();
    editor.applyClipProperties([clipId], 'agent', (draft) => {
      draft.blendMode = 'multiply';
      return true;
    });
    expect(clip(editor).blendMode).toBe('multiply');

    // The user edits the same clip; the renderer pushes its project to main.
    mirrorPush(editor, (c) => ({ ...c, blendMode: 'screen', opacity: 0.9 }));
    const afterUserEdit = { ...clip(editor) };
    expect(afterUserEdit).toMatchObject({ blendMode: 'screen', opacity: 0.9 });

    expect(editor.undo()).toBe(false);
    expect(editor.getUndoRefusal()).toBe('stale');
    // The user's edit is intact: opacity was never the agent's to undo, and
    // blendMode is the field the stale capture would have reverted.
    expect(clip(editor)).toMatchObject({ blendMode: 'screen', opacity: 0.9 });
  });

  it('refuses rather than replacing the document with a pre-edit snapshot', () => {
    const { editor } = seeded();
    // The ReplaceProjectCommand shape: whole-document agent edit.
    editor.adoptProject({ ...editor.getProject(), name: 'Agent Renamed' }, 'Agent rename');
    expect(editor.getProject().name).toBe('Agent Renamed');

    mirrorPush(editor, (c) => ({ ...c, opacity: 0.25, label: 'USER WORK' }));
    const documentBefore = editor.getProject();

    expect(editor.undo()).toBe(false);
    expect(editor.getUndoRefusal()).toBe('stale');
    expect(editor.getProject().name).toBe('Agent Renamed');
    expect(clip(editor)).toMatchObject({ opacity: 0.25, label: 'USER WORK' });
    // Not merely the same name: the timeline object the user was editing.
    expect(editor.getProject().timeline).toBe(documentBefore.timeline);
  });

  it('a refused undo consumes nothing and leaves canUndo true', () => {
    const { editor, clipId } = seeded();
    editor.applyClipProperties([clipId], 'agent', (draft) => {
      draft.blendMode = 'multiply';
      return true;
    });
    mirrorPush(editor, (c) => ({ ...c, blendMode: 'screen' }));

    expect(editor.undo()).toBe(false);
    expect(editor.canUndo()).toBe(true);
    expect(editor.getLastCommandDescription()).toBe('setClipProperties');
    // A second attempt refuses identically rather than succeeding or throwing:
    // the counter only moves forward, so a stale entry stays stale.
    expect(editor.undo()).toBe(false);
    expect(editor.getUndoRefusal()).toBe('stale');
    expect(clip(editor).blendMode).toBe('screen');
  });

  it('refuses redo on the same grounds', () => {
    const { editor, clipId } = seeded();
    editor.applyClipProperties([clipId], 'agent', (draft) => {
      draft.blendMode = 'multiply';
      return true;
    });
    expect(editor.undo()).toBe(true);
    mirrorPush(editor, (c) => ({ ...c, blendMode: 'screen' }));

    expect(editor.redo()).toBe(false);
    expect(editor.getUndoRefusal()).toBe('stale');
    expect(clip(editor).blendMode).toBe('screen');
  });

  it('still reports an empty stack as empty, not stale', () => {
    // No media and no clips, so nothing has ever been a command: the stacks are
    // empty from the start.
    const editor = new EditorController();
    expect(editor.canUndo()).toBe(false);
    expect(editor.undo()).toBe(false);
    expect(editor.getUndoRefusal()).toBe('empty');
    expect(editor.redo()).toBe(false);
    expect(editor.getUndoRefusal()).toBe('empty');
  });
});

describe('the benign sequence is untouched', () => {
  it('applies and undoes back to the original with no mirror write', () => {
    const { editor, clipId } = seeded();
    const before = clip(editor);

    editor.applyClipProperties([clipId], 'agent', (draft) => {
      draft.blendMode = 'multiply';
      return true;
    });
    expect(clip(editor).blendMode).toBe('multiply');

    expect(editor.undo()).toBe(true);
    expect(editor.getUndoRefusal()).toBeNull();
    expect(clip(editor)).toEqual(before);

    expect(editor.redo()).toBe(true);
    expect(clip(editor).blendMode).toBe('multiply');
  });

  it('undoes a run of commands one at a time, as before', () => {
    const editor = new EditorController();
    const startTracks = editor.getProject().timeline.tracks.length;
    editor.addTrack('video');
    editor.addTrack('video');
    editor.addTrack('video');
    expect(editor.getProject().timeline.tracks).toHaveLength(startTracks + 3);

    expect(editor.undo()).toBe(true);
    expect(editor.undo()).toBe(true);
    expect(editor.undo()).toBe(true);
    expect(editor.getProject().timeline.tracks).toHaveLength(startTracks);
    expect(editor.undo()).toBe(false);
    expect(editor.getUndoRefusal()).toBe('empty');
  });
});

describe('every path that changes the project without a command', () => {
  it('setProjectFromMirror — a push carrying authored change — makes a pending entry stale', () => {
    // The one write that replaces the project with no command behind it, and so
    // the only place the counter has to move for main's history to be safe. It
    // has to carry authored change to count: see the view-state cases below.
    const { editor, clipId } = seeded();
    editor.applyClipProperties([clipId], 'agent', (draft) => {
      draft.blendMode = 'multiply';
      return true;
    });
    mirrorPush(editor, (c) => ({ ...c, blendMode: 'screen' }));
    expect(editor.undo()).toBe(false);
    expect(editor.getUndoRefusal()).toBe('stale');
  });

  it('a mirror push carrying only view state is NOT a foreign write', () => {
    // The correction. The renderer's debounced push carries the cursor, so an
    // unconditional bump made an agent undo permanently unavailable after the
    // user merely moved the playhead. A captured inverse cannot cover a
    // playhead or a mark, so moving one cannot stale anything.
    const { editor, clipId } = seeded();
    editor.applyClipProperties([clipId], 'agent', (draft) => {
      draft.blendMode = 'multiply';
      return true;
    });

    for (const viewOnly of [
      (p: Project) => ({ ...p, timeline: { ...p.timeline, playheadFrame: 99 } }),
      (p: Project) => ({ ...p, timeline: { ...p.timeline, inFrame: 5 } }),
      (p: Project) => ({ ...p, timeline: { ...p.timeline, outFrame: 15 } }),
      (p: Project) => ({ ...p, timeline: { ...p.timeline, inFrame: 5, outFrame: 15 } }),
      (p: Project) => ({ ...p, timeline: { ...p.timeline, inFrame: undefined, outFrame: undefined } }),
    ]) {
      editor.setProjectFromMirror(viewOnly(editor.getProject()));

      expect(editor.undo()).toBe(true);
      expect(editor.getUndoRefusal()).toBeNull();
      expect(clip(editor).blendMode).not.toBe('multiply');

      // Re-apply, so each variant is tested against a live pending entry.
      editor.applyClipProperties([clipId], 'agent', (draft) => {
        draft.blendMode = 'multiply';
        return true;
      });
    }
  });

  it('exempts the same view state on a NESTED timeline', () => {
    // The exclusion is applied per timeline, not once at the root: a push can
    // carry a nested sequence's playhead, and that is still just a cursor.
    const editor = new EditorController();
    editor.addMedia({
      id: 'm',
      path: 'X:/media/m.mp4',
      filename: 'm.mp4',
      type: 'video',
      duration: 300,
      width: 1920,
      height: 1080,
      fileSize: 1,
      addedAt: '2026-01-01T00:00:00.000Z',
    });
    const inner = editor.addClip({ assetId: 'm', trackId: 'v1', startFrame: 100, durationFrames: 60 });
    editor.nestClips([inner], { name: 'Inner' });
    const [nestedId] = Object.keys(editor.getProject().timelines ?? {});
    expect(nestedId).toBeDefined();

    editor.applyClipProperties([editor.getProject().timeline.clips[0]!.id], 'agent', (draft) => {
      draft.label = 'AGENT';
      return true;
    });

    const project = editor.getProject();
    editor.setProjectFromMirror({
      ...project,
      timelines: { ...project.timelines, [nestedId!]: { ...project.timelines![nestedId!], playheadFrame: 77 } },
    });

    expect(editor.undo()).toBe(true);
    expect(editor.getUndoRefusal()).toBeNull();
  });

  it('a push mixing view state with authored change still bumps', () => {
    // Guards against reading the exclusion as "skip the bump when a view field
    // appears in the diff": the comparison is about the whole difference, not
    // about whether any excluded field moved.
    const { editor, clipId } = seeded();
    editor.applyClipProperties([clipId], 'agent', (draft) => {
      draft.blendMode = 'multiply';
      return true;
    });

    const project = editor.getProject();
    editor.setProjectFromMirror({
      ...project,
      timeline: {
        ...project.timeline,
        playheadFrame: 99,
        clips: project.timeline.clips.map((c) => ({ ...c, blendMode: 'screen' })),
      },
    });

    expect(editor.undo()).toBe(false);
    expect(editor.getUndoRefusal()).toBe('stale');
    expect(clip(editor).blendMode).toBe('screen');
  });

  it('cannot be bypassed: a view-only push then an authored one still refuses', () => {
    // The sequence that would slip through if the exemption cleared the pending
    // entry's version instead of skipping the bump.
    const { editor, clipId } = seeded();
    editor.applyClipProperties([clipId], 'agent', (draft) => {
      draft.blendMode = 'multiply';
      return true;
    });

    const viewed = editor.getProject();
    editor.setProjectFromMirror({ ...viewed, timeline: { ...viewed.timeline, playheadFrame: 99 } });
    expect(editor.undo()).toBe(true);

    editor.applyClipProperties([clipId], 'agent', (draft) => {
      draft.blendMode = 'multiply';
      return true;
    });
    mirrorPush(editor, (c) => ({ ...c, blendMode: 'screen' }));

    expect(editor.undo()).toBe(false);
    expect(editor.getUndoRefusal()).toBe('stale');
    expect(clip(editor).blendMode).toBe('screen');
  });

  it('loadProject and reset drop the history outright, so there is nothing to stale', () => {
    // Exempt by construction rather than by a counter bump: clearing the stacks
    // is what protects them, and an empty stack is not a stale entry.
    for (const wipe of [
      (e: EditorController) => e.loadProject(e.getProject()),
      (e: EditorController) => e.reset(),
    ]) {
      const { editor, clipId } = seeded();
      editor.applyClipProperties([clipId], 'agent', (draft) => {
        draft.blendMode = 'multiply';
        return true;
      });
      expect(editor.canUndo()).toBe(true);

      wipe(editor);

      expect(editor.canUndo()).toBe(false);
      expect(editor.undo()).toBe(false);
      expect(editor.getUndoRefusal()).toBe('empty');
    }
  });

  it('cursor and mark state do not stale the history — the render local path', () => {
    // Deliberately exempt. These write the project directly and push no history
    // entry, because they are cursor state rather than authored content: a
    // command's captured inverse never covers a playhead or a mark, so none of
    // them can be made stale by one moving. Bumping here would instead mean a
    // user could not move the playhead and then press Ctrl+Z.
    const { editor, clipId } = seeded();
    editor.applyClipProperties([clipId], 'agent', (draft) => {
      draft.blendMode = 'multiply';
      return true;
    });

    editor.setPlayhead(42);
    editor.setMarkedRange(10, 20);
    editor.clearMarkedRange();
    editor.setInFrame(5);
    editor.setOutFrame(15);

    expect(editor.undo()).toBe(true);
    expect(editor.getUndoRefusal()).toBeNull();
    expect(clip(editor).blendMode).not.toBe('multiply');
  });
});

describe('the renderer controller is unchanged', () => {
  it('local edits still undo to the same depth with the same labels', () => {
    // The renderer's history is its own instance and its entries are all local,
    // so nothing here can go stale. Depth and labels are what the renderer tests
    // encode, so they are pinned rather than assumed.
    const editor = new EditorController();
    const startTracks = editor.getProject().timeline.tracks.length;
    editor.addTrack('video');
    editor.addTrack('video');
    editor.addTrack('video');

    expect(editor.getLastCommandDescription()).toBe('addTrack');
    expect(editor.canUndo()).toBe(true);
    for (const remaining of [startTracks + 2, startTracks + 1, startTracks]) {
      expect(editor.undo()).toBe(true);
      expect(editor.getUndoRefusal()).toBeNull();
      expect(editor.getProject().timeline.tracks).toHaveLength(remaining);
    }
    expect(editor.undo()).toBe(false);
  });

  it('a sibling adopt through setProjectSilent does NOT stale the renderer history', () => {
    // The split is the point. Sibling windows adopt a shared snapshot through
    // setProjectSilent, and that is a local view update in the window receiving
    // it: its undo is expected to return to that window's own work, which is
    // what useEditorSync.test.ts pins. Only the main-side mirror write counts.
    const { editor, clipId } = seeded();
    editor.applyClipProperties([clipId], 'local', (draft) => {
      draft.blendMode = 'multiply';
      return true;
    });
    editor.setProjectSilent({ ...editor.getProject(), name: 'Sibling' });

    expect(editor.undo()).toBe(true);
    expect(editor.getUndoRefusal()).toBeNull();
    // The local clip edit rolled back; the adopted name is untouched, because a
    // per-clip command never claimed it.
    expect(clip(editor).blendMode).not.toBe('multiply');
    expect(editor.getProject().name).toBe('Sibling');
  });
});

describe('CommandHistory versioning in isolation', () => {
  it('an entry applied after a foreign write undoes normally', () => {
    const { editor } = seeded();
    editor.setProjectFromMirror(editor.getProject());
    // Fresh entry, current version: the mirror write before it does not stale it.
    editor.addTrack('video');
    expect(editor.undo()).toBe(true);
    expect(editor.getUndoRefusal()).toBeNull();
  });

  it('a foreign write is the only thing that stales an entry', () => {
    const history = new CommandHistory();
    const project = new EditorController().getProject();
    const entry = new AddTrackCommand({
      id: 't1', name: 'Video 1', type: 'video', locked: false, visible: true,
      syncLocked: true, order: 1,
    });
    const applied = history.execute(entry, project);

    // Same version: the entry still describes the project.
    expect(history.undo(applied)).not.toBeNull();
    expect(history.lastRefusalReason()).toBeNull();

    const again = history.execute(entry, project);
    history.noteForeignWrite();
    expect(history.undo(again)).toBeNull();
    expect(history.lastRefusalReason()).toBe('stale');
    // Refusing left the entry alone rather than dropping it.
    expect(history.canUndo()).toBe(true);
  });
});
