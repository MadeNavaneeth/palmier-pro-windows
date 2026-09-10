/**
 * Regression coverage for the real export_project tool: option mapping,
 * success/error receipts from the exporter's event sink, and refusal of a
 * non-absolute path. Encoding itself is injected, so no FFmpeg runs here.
 */
import { describe, expect, it, vi } from 'vitest';
import { ToolExecutor } from './executor';
import { EditorController } from '../../shared/editor/controller';
import type { ExportEventSink, ExportOptions } from '../media/exporter';

function harness(runExport?: (
  project: unknown,
  options: ExportOptions,
  sink: ExportEventSink,
) => Promise<void>) {
  const editor = new EditorController();
  const executor = new ToolExecutor(editor, runExport ? { runExport: runExport as never } : {});
  return { editor, executor };
}

describe('export_project', () => {
  it('runs the injected exporter and returns a receipt', async () => {
    let captured: ExportOptions | null = null;
    const runExport = vi.fn(async (_project, options: ExportOptions, sink: ExportEventSink) => {
      captured = options;
      sink.send('export:complete', { outputPath: options.outputPath, bytes: 1234 });
    });
    const { executor } = harness(runExport);

    const result = await executor.execute('export_project', {
      outputPath: 'C:\\out\\reel.mp4',
      format: 'mov',
      quality: 'high',
    });

    expect(result.success).toBe(true);
    expect(captured).toMatchObject({ outputPath: 'C:\\out\\reel.mp4', format: 'mov', quality: 'high' });
    expect(result.data).toMatchObject({ bytes: 1234, format: 'mov', quality: 'high' });
  });

  it('surfaces an exporter error event even when the run resolves', async () => {
    const runExport = vi.fn(async (_project, _options: ExportOptions, sink: ExportEventSink) => {
      sink.send('export:error', 'Media offline: clip.mp4. Relink or remove it before exporting.');
    });
    const { executor } = harness(runExport);

    const result = await executor.execute('export_project', {
      outputPath: 'C:\\out\\reel.mp4',
    });

    expect(result.success).toBe(false);
    expect((result as { error?: string }).error).toMatch(/media offline/i);
  });

  it('surfaces an exporter rejection', async () => {
    const runExport = vi.fn(async () => {
      throw new Error('FFmpeg exit code 1');
    });
    const { executor } = harness(runExport);

    const result = await executor.execute('export_project', {
      outputPath: 'C:\\out\\reel.mp4',
    });

    expect(result.success).toBe(false);
    expect((result as { error?: string }).error).toContain('exit code 1');
  });

  it('refuses a relative output path before starting a render', async () => {
    const runExport = vi.fn(async () => {});
    const { executor } = harness(runExport);

    const result = await executor.execute('export_project', { outputPath: 'out/reel.mp4' });

    expect(result.success).toBe(false);
    expect((result as { error?: string }).error).toMatch(/absolute/i);
    expect(runExport).not.toHaveBeenCalled();
  });

  it('applies the schema defaults when format and quality are omitted', async () => {
    let captured: ExportOptions | null = null;
    const runExport = vi.fn(async (_project, options: ExportOptions, sink: ExportEventSink) => {
      captured = options;
      sink.send('export:complete', { outputPath: options.outputPath, bytes: 1 });
    });
    const { executor } = harness(runExport);

    await executor.execute('export_project', { outputPath: 'C:\\out\\reel.mp4' });

    expect(captured).toMatchObject({ format: 'mp4', quality: 'normal' });
  });
});
