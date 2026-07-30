/**
 * Regression coverage for the set_project_settings tool contract
 * (upstream PR #417: MCPCustomAspectRatioTests + ToolExecutorTests).
 */

import { describe, it, expect } from 'vitest';
import { ToolExecutor, resolveProjectSettings } from './executor';
import { getToolByName, toolsToJsonSchema } from './tools';
import { EditorController } from '../../shared/editor/controller';
import { DEFAULT_PROJECT_SETTINGS } from '../../shared/types/project';

function harness() {
  const editor = new EditorController();
  return { editor, executor: new ToolExecutor(editor) };
}

describe('set_project_settings discovery', () => {
  it('advertises aspectRatio as a free-form string, not a closed enum', () => {
    const schema = toolsToJsonSchema().find((tool) => tool.name === 'set_project_settings');
    const inputSchema = schema!.inputSchema as {
      properties: Record<string, { type?: string; enum?: string[] }>;
      required?: string[];
    };

    expect(inputSchema.properties.aspectRatio.type).toBe('string');
    expect(inputSchema.properties.aspectRatio.enum).toBeUndefined();
    // quality stays a closed set.
    expect(inputSchema.properties.quality.enum).toEqual(['720p', '1080p', '2K', '4K']);
    // Every field is optional; the executor enforces the combination rules.
    expect(inputSchema.required).toBeUndefined();
  });

  it('is registered under the shared tool contract', () => {
    expect(getToolByName('set_project_settings')).toBeDefined();
  });
});

describe('set_project_settings argument resolution', () => {
  const current = { ...DEFAULT_PROJECT_SETTINGS }; // 1920x1080 @30

  it('requires at least one field', () => {
    expect(() => resolveProjectSettings({}, current)).toThrow(
      'Provide at least one of: fps, width, height, aspectRatio, quality',
    );
  });

  it('requires width and height together', () => {
    expect(() => resolveProjectSettings({ width: 1440 }, current)).toThrow(
      'Provide both width and height',
    );
    expect(() => resolveProjectSettings({ height: 1440 }, current)).toThrow(
      'Provide both width and height',
    );
  });

  it('refuses explicit dimensions combined with aspectRatio or quality', () => {
    expect(() =>
      resolveProjectSettings({ width: 1440, height: 1080, aspectRatio: '4:3' }, current),
    ).toThrow("Explicit dimensions can't be combined with aspectRatio or quality");
    expect(() =>
      resolveProjectSettings({ width: 1440, height: 1080, quality: '4K' }, current),
    ).toThrow("Explicit dimensions can't be combined with aspectRatio or quality");
  });

  it('preserves the current short edge for a custom ratio', () => {
    expect(resolveProjectSettings({ aspectRatio: '3:2' }, current)).toEqual({
      width: 1620,
      height: 1080,
    });
  });

  it('uses the quality short edge when both are supplied', () => {
    expect(resolveProjectSettings({ aspectRatio: '2.39:1', quality: '4K' }, current)).toEqual({
      width: 5162,
      height: 2160,
    });
  });

  it('scales the current ratio for a quality-only change', () => {
    expect(resolveProjectSettings({ quality: '4K' }, current)).toEqual({
      width: 3840,
      height: 2160,
    });
  });

  it('surfaces the aspect-ratio refusal message', () => {
    expect(() => resolveProjectSettings({ aspectRatio: 'wide' }, current)).toThrow(
      'Use an aspect ratio with two positive numbers, such as 3:2.',
    );
    expect(() => resolveProjectSettings({ aspectRatio: '100:1' }, current)).toThrow(
      'Resolution must not exceed 8192 pixels on either edge.',
    );
  });

  it('leaves the resolution alone for an fps-only change', () => {
    expect(resolveProjectSettings({ fps: 60 }, { ...current, width: 9000, height: 4500 })).toEqual({
      fps: 60,
    });
  });
});

describe('set_project_settings execution', () => {
  it('applies a custom ratio at a quality preset and reports the receipt', async () => {
    const { editor, executor } = harness();

    const result = await executor.execute('set_project_settings', {
      aspectRatio: '2.39:1',
      quality: '4K',
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      fps: 30,
      resolution: '5162x2160',
      aspectRatio: '2.39:1',
      changed: ['resolution'],
    });
    expect(editor.getProject().settings).toMatchObject({ width: 5162, height: 2160 });
  });

  it('reads the canvas back through get_timeline', async () => {
    const { executor } = harness();
    await executor.execute('set_project_settings', { aspectRatio: '9:16' });

    const timeline = await executor.execute('get_timeline', {});

    expect(timeline.success).toBe(true);
    expect(timeline.data).toMatchObject({ width: 1080, height: 1920, fps: 30, aspectRatio: '9:16' });
  });

  it('reports a no-op when the settings already match', async () => {
    const { executor } = harness();
    await executor.execute('set_project_settings', { aspectRatio: '2.39:1', quality: '4K' });

    const repeated = await executor.execute('set_project_settings', {
      aspectRatio: '2.39:1',
      quality: '4K',
    });

    expect(repeated.success).toBe(true);
    expect(repeated.data).toMatchObject({ changed: [], note: 'Settings already matched.' });
  });

  it('rejects an invalid request without changing the project', async () => {
    const { editor, executor } = harness();
    await executor.execute('set_project_settings', { aspectRatio: '2.39:1', quality: '4K' });
    const before = editor.getProject();

    const invalid = await executor.execute('set_project_settings', { width: 1440 });

    expect(invalid.success).toBe(false);
    expect(invalid.error).toContain('Provide both width and height');
    expect(editor.getProject()).toBe(before);
  });

  it('rejects an out-of-range frame rate at the schema boundary', async () => {
    const { editor, executor } = harness();

    const invalid = await executor.execute('set_project_settings', { fps: 500 });

    expect(invalid.success).toBe(false);
    expect(invalid.error).toContain('Validation error');
    expect(editor.getProject().settings.fps).toBe(30);
  });

  it('is undoable through the shared command history', async () => {
    const { editor, executor } = harness();
    await executor.execute('set_project_settings', { aspectRatio: '2.39:1', quality: '4K' });

    expect((await executor.execute('undo', {})).success).toBe(true);
    expect(editor.getProject().settings).toMatchObject({ width: 1920, height: 1080 });
    expect((await executor.execute('undo', {})).success).toBe(false);
  });
});
