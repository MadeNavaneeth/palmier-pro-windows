/**
 * The agent's `undo` / `redo` receipts when the project moved underneath them.
 *
 * Main's history holds only agent commands, and the renderer's authoritative
 * project arrives as a wholesale write that goes through none of them. Undoing
 * an agent command after such a write used to revert the user's edit — or, for a
 * whole-document command, replace the entire project with its pre-edit self —
 * and report `success: true` while doing it. The refusal is surfaced here the
 * same way the FCPXML rate refusal is: `success: false` with a specific `error`.
 */
import { describe, expect, it } from 'vitest';
import { ToolExecutor } from './executor';
import { EditorController } from '../../shared/editor/controller';
import type { Clip, Project } from '../../shared/types/project';

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

/** The renderer->main mirror arriving over IPC, as `editor-sync.ts` delivers it. */
function rendererPush(editor: EditorController, edit: (c: Clip) => Clip): void {
  const project: Project = editor.getProject();
  editor.setProjectFromMirror({
    ...project,
    timeline: { ...project.timeline, clips: project.timeline.clips.map(edit) },
  });
}

describe('agent undo/redo after a renderer edit', () => {
  it('still undoes after a playhead-only push, returning the pre-command state', async () => {
    // The primary case for the view-state exclusion. The renderer's debounced
    // push carries the playhead, so a cursor move reaches main on nearly every
    // edit. Treating that as a foreign write made an agent undo permanently
    // unavailable after the user merely moved the playhead, which is the cost
    // this rule exists to avoid.
    const { editor, clipId } = seeded();
    const executor = new ToolExecutor(editor);
    const beforeAgentEdit = { ...clip(editor) };

    await executor.execute('set_clip_blend_mode', { clipId, blendMode: 'multiply' });
    expect(clip(editor).blendMode).toBe('multiply');

    // The user scrubs. Nothing authored changes, so the mirror write is not a
    // foreign change to the agent's captured inverse state.
    editor.setPlayhead(99);
    const pushed = editor.getProject();
    editor.setProjectFromMirror({ ...pushed, timeline: { ...pushed.timeline, playheadFrame: 99 } });
    expect(editor.getProject().timeline.playheadFrame).toBe(99);

    const undone = await executor.execute('undo', {});

    // Byte-identical to the benign receipt, and the agent's edit is rolled back.
    expect(undone).toEqual({ success: true, data: { action: 'undo' } });
    expect(clip(editor)).toEqual(beforeAgentEdit);
    expect(editor.getUndoRefusal()).toBeNull();
  });

  it('still refuses when the push carries a real change to the clip the agent touched', async () => {
    // The load-bearing half: the exclusion is for view state only, so an authored
    // change alongside it must still invalidate the capture.
    const { editor, clipId } = seeded();
    const executor = new ToolExecutor(editor);

    await executor.execute('set_clip_blend_mode', { clipId, blendMode: 'multiply' });

    const project = editor.getProject();
    editor.setProjectFromMirror({
      ...project,
      timeline: {
        ...project.timeline,
        playheadFrame: 99,
        clips: project.timeline.clips.map((c) => ({ ...c, blendMode: 'screen' })),
      },
    });

    const undone = await executor.execute('undo', {});

    expect(undone.success).toBe(false);
    expect(undone.error).toBe(
      'Cannot undo: the project changed since that step was applied, so undoing it would '
      + 'overwrite work done since. Undo it from the window instead.',
    );
    expect(clip(editor)).toMatchObject({ blendMode: 'screen' });
  });

  it('refuses, names the reason, and leaves the user edit alone', async () => {
    const { editor, clipId } = seeded();
    const executor = new ToolExecutor(editor);

    const applied = await executor.execute('set_clip_blend_mode', { clipId, blendMode: 'multiply' });
    expect(applied.success).toBe(true);
    expect(clip(editor).blendMode).toBe('multiply');

    // The user restyles the same clip in the window; the project is mirrored.
    rendererPush(editor, (c) => ({ ...c, blendMode: 'screen', opacity: 0.9 }));
    expect(clip(editor)).toMatchObject({ blendMode: 'screen', opacity: 0.9 });

    const undone = await executor.execute('undo', {});

    expect(undone.success).toBe(false);
    expect(undone.error).toBe(
      'Cannot undo: the project changed since that step was applied, so undoing it would '
      + 'overwrite work done since. Undo it from the window instead.',
    );
    // The user's edit is intact, in both fields the stale capture would have hit.
    expect(clip(editor)).toMatchObject({ blendMode: 'screen', opacity: 0.9 });
  });

  it('refuses a whole-document command instead of replacing the project', async () => {
    const { editor } = seeded();
    const executor = new ToolExecutor(editor);

    // The ReplaceProjectCommand shape an agent edit produces.
    editor.adoptProject({ ...editor.getProject(), name: 'Agent Renamed' }, 'Agent rename');
    rendererPush(editor, (c) => ({ ...c, opacity: 0.25, label: 'USER WORK' }));
    const documentBefore = editor.getProject();

    const undone = await executor.execute('undo', {});

    expect(undone.success).toBe(false);
    expect(undone.error).toContain('the project changed since');
    // The document the user was editing is still the document, by identity.
    expect(editor.getProject().timeline).toBe(documentBefore.timeline);
    expect(editor.getProject().name).toBe('Agent Renamed');
    expect(clip(editor)).toMatchObject({ opacity: 0.25, label: 'USER WORK' });
  });

  it('still succeeds with the pre-existing receipt when nothing intervened', async () => {
    const { editor, clipId } = seeded();
    const executor = new ToolExecutor(editor);
    const before = { ...clip(editor) };

    await executor.execute('set_clip_blend_mode', { clipId, blendMode: 'multiply' });
    const undone = await executor.execute('undo', {});

    expect(undone).toEqual({ success: true, data: { action: 'undo' } });
    expect(clip(editor)).toEqual(before);
  });

  it('reports the pre-existing empty wording when there is no history at all', async () => {
    const executor = new ToolExecutor(new EditorController());

    expect(await executor.execute('undo', {}))
      .toEqual({ success: false, error: 'Nothing to undo.' });
    expect(await executor.execute('redo', {}))
      .toEqual({ success: false, error: 'Nothing to redo.' });
  });

  it('a refusal consumes nothing, so the stack is not quietly shortened', async () => {
    const { editor, clipId } = seeded();
    const executor = new ToolExecutor(editor);
    await executor.execute('set_clip_blend_mode', { clipId, blendMode: 'multiply' });
    rendererPush(editor, (c) => ({ ...c, blendMode: 'screen' }));
    const tracksBefore = editor.getProject().timeline.tracks.length;

    expect((await executor.execute('undo', {})).success).toBe(false);

    expect(editor.canUndo()).toBe(true);
    expect(editor.getProject().timeline.tracks).toHaveLength(tracksBefore);
    // Still a refusal, not a success and not a throw.
    expect((await executor.execute('undo', {})).success).toBe(false);
    expect(clip(editor).blendMode).toBe('screen');
  });

  it('refuses redo on the same grounds, with its own wording', async () => {
    const { editor, clipId } = seeded();
    const executor = new ToolExecutor(editor);
    await executor.execute('set_clip_blend_mode', { clipId, blendMode: 'multiply' });
    expect((await executor.execute('undo', {})).success).toBe(true);
    rendererPush(editor, (c) => ({ ...c, blendMode: 'screen' }));

    const redone = await executor.execute('redo', {});

    expect(redone.success).toBe(false);
    expect(redone.error).toBe(
      'Cannot redo: the project changed since that step was applied, so redoing it would '
      + 'overwrite work done since. Redo it from the window instead.',
    );
    expect(clip(editor).blendMode).toBe('screen');
  });

  it('a second agent command after the renderer edit is itself undoable-until-pushed', async () => {
    // The entry applied AFTER the push is not stale: the push is what is behind
    // it, not in front of it. This is the boundary that a blanket "bump clears
    // the stack" implementation would get wrong.
    const { editor, clipId } = seeded();
    const executor = new ToolExecutor(editor);
    rendererPush(editor, (c) => ({ ...c, opacity: 0.9 }));

    await executor.execute('set_clip_blend_mode', { clipId, blendMode: 'multiply' });
    expect(clip(editor).blendMode).toBe('multiply');

    expect((await executor.execute('undo', {})).success).toBe(true);
    expect(clip(editor).blendMode).not.toBe('multiply');
    expect(clip(editor).opacity).toBe(0.9);
  });
});
