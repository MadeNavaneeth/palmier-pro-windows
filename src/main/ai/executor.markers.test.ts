/**
 * Regression coverage for the manage_markers agent tool (upstream PR #542):
 * argument requirements per action, precise validation errors surfaced to the
 * model, no-op receipts, and markers appearing in get_timeline.
 */

import { describe, it, expect } from 'vitest';
import { ToolExecutor } from './executor';
import { EditorController } from '../../shared/editor/controller';

function executorWithMarkers() {
  const editor = new EditorController();
  const executor = new ToolExecutor(editor);
  return { editor, executor };
}

describe('manage_markers tool (#542)', () => {
  it('creates a marker and reports it', async () => {
    const { executor } = executorWithMarkers();
    const result = await executor.execute('manage_markers', {
      action: 'create',
      name: 'Fix pacing here',
      startFrame: 120,
    });
    expect(result.success).toBe(true);
    const data = (result.data as { created: Array<{ name: string; startFrame: number }> }).created;
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ name: 'Fix pacing here', startFrame: 120 });
  });

  it('requires action-specific arguments', async () => {
    const { executor } = executorWithMarkers();
    expect((await executor.execute('manage_markers', { action: 'create', startFrame: 5 })).success)
      .toBe(false);
    expect((await executor.execute('manage_markers', { action: 'update' })).success).toBe(false);
    expect((await executor.execute('manage_markers', { action: 'update', markerId: 'x' })).success)
      .toBe(false);
    expect((await executor.execute('manage_markers', { action: 'delete' })).success).toBe(false);
  });

  it('surfaces validation failures with the domain message', async () => {
    const { editor, executor } = executorWithMarkers();
    await executor.execute('manage_markers', { action: 'create', name: 'A', startFrame: 0 });
    const id = editor.getMarkers()[0].id;

    const bad = await executor.execute('manage_markers', {
      action: 'update',
      markerId: id,
      color: 'blue',
    });
    // Rejected at the schema boundary before the domain sees it.
    expect(bad.success).toBe(false);
    expect((bad as { error?: string }).error).toMatch(/invalid|color/i);

    const missing = await executor.execute('manage_markers', {
      action: 'delete',
      markerId: 'ghost',
    });
    expect(missing.success).toBe(false);
    expect((missing as { error?: string }).error).toMatch(/no marker/i);
  });

  it('reports a no-op update without failing', async () => {
    const { editor, executor } = executorWithMarkers();
    await executor.execute('manage_markers', { action: 'create', name: 'A', startFrame: 9 });
    const id = editor.getMarkers()[0].id;

    const result = await executor.execute('manage_markers', {
      action: 'update',
      markerId: id,
      name: 'A',
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ noOp: true });
  });

  it('deletes by id and shows markers in get_timeline', async () => {
    const { editor, executor } = executorWithMarkers();
    await executor.execute('manage_markers', {
      action: 'create',
      name: 'Note',
      startFrame: 30,
      durationFrames: 10,
      comment: 'check audio',
    });
    const id = editor.getMarkers()[0].id;

    const timeline = await executor.execute('get_timeline', {});
    expect((timeline.data as { markers?: Array<{ id: string }> }).markers?.[0]?.id).toBe(id);

    const deleted = await executor.execute('manage_markers', {
      action: 'delete',
      markerId: id,
    });
    expect(deleted.data).toEqual({ deletedMarkerId: id });
    expect(editor.getMarkers()).toHaveLength(0);
  });
});
