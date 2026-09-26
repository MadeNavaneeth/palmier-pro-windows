/**
 * `nest_clips` / `flatten_compound` agent tools (upstream issue #155).
 *
 * Both tools route through the same undoable controller operations the UI
 * uses, so one call is one undo step; refusals (unknown ids, non-compound
 * targets, validation failures) report a precise error and mutate nothing.
 */
import { describe, it, expect } from 'vitest';
import { ToolExecutor } from './executor';
import { EditorController } from '../../shared/editor/controller';

function harness() {
  const editor = new EditorController();
  editor.addMedia({
    id: 'asset',
    path: 'C:\\media\\take.mp4',
    filename: 'take.mp4',
    type: 'video',
    duration: 300,
    fileSize: 1000,
    addedAt: '2026-07-29T00:00:00.000Z',
  });
  const first = editor.addClip({ assetId: 'asset', trackId: 'v1', startFrame: 0, durationFrames: 60 });
  const second = editor.addClip({ assetId: 'asset', trackId: 'v1', startFrame: 60, durationFrames: 40 });
  return { editor, executor: new ToolExecutor(editor), first, second };
}

interface NestReceipt {
  compoundClipId: string;
  timelineId: string;
  timelineName: string;
  nestedClipIds: string[];
  trackId: string;
  startFrame: number;
  durationFrames: number;
}

describe('nest_clips tool', () => {
  it('nests clips and returns the receipt', async () => {
    const { executor, editor, first, second } = harness();
    const result = await executor.execute('nest_clips', { clipIds: [first, second] });
    expect(result.success).toBe(true);
    const receipt = result.data as NestReceipt;
    expect(receipt.compoundClipId).not.toBe('');
    expect(receipt.timelineId).not.toBe('');
    expect(receipt.nestedClipIds).toEqual(expect.arrayContaining([first, second]));
    expect(receipt.durationFrames).toBe(100);
    expect(editor.getClips()).toHaveLength(1);
    expect(editor.getClips()[0].type).toBe('compound');
  });

  it('nests as one undo step', async () => {
    const { executor, editor, first } = harness();
    await executor.execute('nest_clips', { clipIds: [first] });
    const undone = await executor.execute('undo', {});
    expect(undone.success).toBe(true);
    expect(editor.getClips()).toHaveLength(2);
  });

  it('refuses unknown clip ids without mutating', async () => {
    const { executor, editor } = harness();
    const result = await executor.execute('nest_clips', { clipIds: ['ghost'] });
    expect(result.success).toBe(false);
    expect(result.error).toContain('ghost');
    expect(editor.getClips()).toHaveLength(2);
  });

  it('refuses an empty selection at the validation boundary', async () => {
    const { executor, editor } = harness();
    const result = await executor.execute('nest_clips', { clipIds: [] });
    expect(result.success).toBe(false);
    expect(editor.getClips()).toHaveLength(2);
  });
});

describe('flatten_compound tool', () => {
  it('flattens a compound clip and returns the receipt', async () => {
    const { executor, editor, first, second } = harness();
    const nested = await executor.execute('nest_clips', { clipIds: [first, second] });
    const compoundClipId = (nested.data as NestReceipt).compoundClipId;

    const result = await executor.execute('flatten_compound', { clipId: compoundClipId });
    expect(result.success).toBe(true);
    const receipt = result.data as { compoundClipId: string; restoredClipIds: string[] };
    expect(receipt.compoundClipId).toBe(compoundClipId);
    expect(receipt.restoredClipIds).toEqual(expect.arrayContaining([first, second]));
    expect(editor.getClips()).toHaveLength(2);
  });

  it('flattens as one undo step', async () => {
    const { executor, editor, first, second } = harness();
    const nested = await executor.execute('nest_clips', { clipIds: [first, second] });
    const compoundClipId = (nested.data as NestReceipt).compoundClipId;
    await executor.execute('flatten_compound', { clipId: compoundClipId });
    const undone = await executor.execute('undo', {});
    expect(undone.success).toBe(true);
    expect(editor.getClips()).toHaveLength(1);
    expect(editor.getClips()[0].id).toBe(compoundClipId);
  });

  it('refuses plain clips and unknown ids without mutating', async () => {
    const { executor, editor, first } = harness();
    const plain = await executor.execute('flatten_compound', { clipId: first });
    expect(plain.success).toBe(false);
    expect(plain.error).toContain('not a compound');
    const missing = await executor.execute('flatten_compound', { clipId: 'ghost' });
    expect(missing.success).toBe(false);
    expect(missing.error).toContain('ghost');
    expect(editor.getClips()).toHaveLength(2);
  });
});
