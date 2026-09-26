/**
 * Executor coverage for the import_srt tool: cue import through the agent
 * surface, per-call refusals, and single-undo behavior. (The domain mapping
 * itself is pinned in shared/editor/controller.srt.test.ts; this pins the
 * tool dispatch that previously hid behind a dead duplicate case clause.)
 */
import { describe, it, expect } from 'vitest';
import { ToolExecutor } from './executor';
import { EditorController } from '../../shared/editor/controller';

const SRT = [
  '1',
  '00:00:01,000 --> 00:00:03,000',
  'First line',
  '',
  '2',
  '00:00:04,500 --> 00:00:06,000',
  'Second cue',
].join('\n');

function harness() {
  const editor = new EditorController();
  return { editor, executor: new ToolExecutor(editor) };
}

describe('import_srt tool', () => {
  it('imports cues as title clips and reports their ids', async () => {
    const { editor, executor } = harness();
    const result = await executor.execute('import_srt', {
      trackId: 'v1', srtContent: SRT, startFrame: 300,
    });
    expect(result.success).toBe(true);
    const data = result.data as { importedClipIds: string[]; count: number };
    expect(data.count).toBe(2);
    expect(data.importedClipIds).toHaveLength(2);
    const clips = editor.getClips();
    expect(clips.every((c) => c.type === 'title')).toBe(true);
    // Cue 1: [1s,3s) → frames [330, 390) at 30fps.
    expect(clips.find((c) => c.id === data.importedClipIds[0])!.startFrame).toBe(330);
  });

  it('is one undoable step', async () => {
    const { editor, executor } = harness();
    await executor.execute('import_srt', { trackId: 'v1', srtContent: SRT });
    expect(editor.getClips()).toHaveLength(2);
    editor.undo();
    expect(editor.getClips()).toHaveLength(0);
  });

  it('refuses missing/audio/locked tracks and cueless content', async () => {
    const { editor, executor } = harness();
    expect((await executor.execute('import_srt', {
      trackId: 'ghost', srtContent: SRT,
    })).success).toBe(false);
    expect((await executor.execute('import_srt', {
      trackId: 'a1', srtContent: SRT,
    })).success).toBe(false);
    editor.setTrackLocked('v1', true);
    expect((await executor.execute('import_srt', {
      trackId: 'v1', srtContent: SRT,
    })).success).toBe(false);
    editor.setTrackLocked('v1', false);
    const empty = await executor.execute('import_srt', {
      trackId: 'v1', srtContent: 'no cues here',
    });
    expect(empty.success).toBe(false);
    expect((empty as { error?: string }).error).toMatch(/no usable subtitles/i);
    expect(editor.getClips()).toHaveLength(0);
  });
});
