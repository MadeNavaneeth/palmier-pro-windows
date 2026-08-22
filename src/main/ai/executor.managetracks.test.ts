/**
 * Regression coverage for the manage_tracks agent tool (upstream PR #520):
 * receipt shape, refusal messages surfaced verbatim, and no-op receipts.
 */

import { describe, it, expect } from 'vitest';
import { ToolExecutor } from './executor';
import { EditorController } from '../../shared/editor/controller';

function executorWithTracks() {
  const editor = new EditorController();
  return { editor, executor: new ToolExecutor(editor) };
}

describe('manage_tracks tool (#520)', () => {
  it('renames by trackId and reports the final order', async () => {
    const { editor, executor } = executorWithTracks();
    const result = await executor.execute('manage_tracks', {
      set: [{ trackId: 'v1', name: 'Main' }],
    });
    expect(result.success).toBe(true);
    const data = result.data as {
      tracks: Array<{ trackId: string; name: string }>;
      renamed: Array<{ trackId: string; changed: boolean }>;
    };
    expect(data.renamed).toEqual([{ trackId: 'v1', name: 'Main', changed: true }]);
    expect(data.tracks.find((t) => t.trackId === 'v1')?.name).toBe('Main');
    expect(editor.getTracks().find((t) => t.id === 'v1')?.name).toBe('Main');
  });

  it('surfaces refusals verbatim', async () => {
    const { executor } = executorWithTracks();
    const both = await executor.execute('manage_tracks', {
      set: [{ trackId: 'v1', index: 0, name: 'X' }],
    });
    expect(both.success).toBe(false);
    expect((both as { error?: string }).error).toMatch(/pass one current trackId or index/i);

    const empty = await executor.execute('manage_tracks', {});
    expect(empty.success).toBe(false);
    expect((empty as { error?: string }).error).toMatch(/nothing to do/i);

    const outOfRange = await executor.execute('manage_tracks', {
      reorder: [{ index: 9, to: 0 }],
    });
    expect(outOfRange.success).toBe(false);
    expect((outOfRange as { error?: string }).error).toMatch(/out of range/i);
  });

  it('reports a no-op without failing', async () => {
    const { executor } = executorWithTracks();
    const result = await executor.execute('manage_tracks', {
      set: [{ trackId: 'v1', muted: false }],
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ noOp: true });
  });

  it('removes an empty track by bare id string', async () => {
    const { editor, executor } = executorWithTracks();
    const v2 = editor.addTrack('video', 'Video 2');
    const result = await executor.execute('manage_tracks', { remove: [v2] });
    expect(result.success).toBe(true);
    expect((result.data as { removedTracks: Array<{ trackId: string }> }).removedTracks)
      .toEqual([{ trackId: v2, label: 'Video 2', type: 'video' }]);
    expect(editor.getTracks().some((t) => t.id === v2)).toBe(false);
  });
});
