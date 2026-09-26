/**
 * Regression coverage for the set_clip_noise_reduction agent tool (upstream #165):
 * set/overwrite, the 0/clear removal contract (matches the Inspector slider,
 * which deletes the field at 0), audio-only refusal, schema bounds,
 * one-undo-step semantics, and listing through the shared tools table that
 * MCP registration and the agent both read.
 */

import { describe, expect, it } from 'vitest';
import { EditorController } from '../../shared/editor/controller';
import { ToolExecutor } from './executor';
import { getToolByName, isReadOnlyTool, toolsToJsonSchema } from './tools';

function harness() {
  const editor = new EditorController();
  editor.addMedia({
    id: 'a', path: 'X:/a.wav', filename: 'a.wav', type: 'audio',
    duration: 10, fileSize: 1, addedAt: new Date().toISOString(),
  });
  editor.addMedia({
    id: 'v', path: 'X:/v.mp4', filename: 'v.mp4', type: 'video',
    duration: 10, fileSize: 1, addedAt: new Date().toISOString(),
  });
  const clipId = editor.addClip({ assetId: 'a', trackId: 'a1', startFrame: 0, durationFrames: 60 });
  const videoId = editor.addClip({ assetId: 'v', trackId: 'v1', startFrame: 0, durationFrames: 60 });
  return { editor, executor: new ToolExecutor(editor), clipId, videoId };
}

interface DenoiseData {
  changed?: boolean;
  noiseReduction?: number | null;
  cleared?: boolean;
}

describe('set_clip_noise_reduction (#165)', () => {
  it('sets the strength and reports it in the receipt', async () => {
    const { editor, executor, clipId } = harness();

    const result = await executor.execute('set_clip_noise_reduction', { clipId, noiseReduction: 60 });

    expect(result.success).toBe(true);
    const data = result.data as DenoiseData;
    expect(data.changed).toBe(true);
    expect(data.noiseReduction).toBe(60);
    expect(data.cleared).toBe(false);
    expect(editor.getClips().find((c) => c.id === clipId)?.noiseReduction).toBe(60);
  });

  it('overwrites a previous strength', async () => {
    const { editor, executor, clipId } = harness();
    await executor.execute('set_clip_noise_reduction', { clipId, noiseReduction: 60 });

    await executor.execute('set_clip_noise_reduction', { clipId, noiseReduction: 25 });

    expect(editor.getClips().find((c) => c.id === clipId)?.noiseReduction).toBe(25);
  });

  it('0 removes the stage (the Inspector slider-at-0 contract)', async () => {
    const { editor, executor, clipId } = harness();
    await executor.execute('set_clip_noise_reduction', { clipId, noiseReduction: 80 });

    const result = await executor.execute('set_clip_noise_reduction', { clipId, noiseReduction: 0 });

    expect(result.success).toBe(true);
    const data = result.data as DenoiseData;
    expect(data.cleared).toBe(true);
    expect(data.noiseReduction).toBeNull();
    expect(editor.getClips().find((c) => c.id === clipId)?.noiseReduction).toBeUndefined();
  });

  it('clear removes it in one step', async () => {
    const { editor, executor, clipId } = harness();
    await executor.execute('set_clip_noise_reduction', { clipId, noiseReduction: 60 });

    const result = await executor.execute('set_clip_noise_reduction', { clipId, clear: true });

    expect(result.success).toBe(true);
    expect((result.data as DenoiseData).noiseReduction).toBeNull();
    expect(editor.getClips().find((c) => c.id === clipId)?.noiseReduction).toBeUndefined();
  });

  it('refuses video clips and unknown ids, and bounds values at the schema', async () => {
    const { executor, clipId, videoId } = harness();

    const video = await executor.execute('set_clip_noise_reduction', { clipId: videoId, noiseReduction: 60 });
    expect(video.success).toBe(false);
    expect((video as { error?: string }).error).toMatch(/audio clips/i);

    const missing = await executor.execute('set_clip_noise_reduction', { clipId: 'ghost', noiseReduction: 60 });
    expect(missing.success).toBe(false);

    const over = await executor.execute('set_clip_noise_reduction', { clipId, noiseReduction: 101 });
    expect(over.success).toBe(false);

    const under = await executor.execute('set_clip_noise_reduction', { clipId, noiseReduction: -1 });
    expect(under.success).toBe(false);

    const fraction = await executor.execute('set_clip_noise_reduction', { clipId, noiseReduction: 60.5 });
    expect(fraction.success).toBe(false);

    const empty = await executor.execute('set_clip_noise_reduction', { clipId });
    expect(empty.success).toBe(false);
  });

  it('is one undo step', async () => {
    const { editor, executor, clipId } = harness();
    await executor.execute('set_clip_noise_reduction', { clipId, noiseReduction: 60 });

    expect(editor.undo()).toBe(true);

    expect(editor.getClips().find((c) => c.id === clipId)?.noiseReduction).toBeUndefined();
  });

  it('is listed on the tools table MCP and the agent both read', () => {
    expect(getToolByName('set_clip_noise_reduction')).toBeDefined();
    expect(toolsToJsonSchema().map((tool) => tool.name)).toContain('set_clip_noise_reduction');
    // Mutating by default: absent from READ_ONLY_TOOLS (see the side-table note).
    expect(isReadOnlyTool('set_clip_noise_reduction')).toBe(false);
  });
});
