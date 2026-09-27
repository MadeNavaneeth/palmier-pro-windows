/**
 * Regression coverage for the real export_project tool: option mapping,
 * success/error receipts from the exporter's event sink, refusal of a
 * non-absolute path, and the HDR profile's set/clear/refusal receipts
 * (upstream #59). Encoding itself is injected, so no FFmpeg runs here.
 */
import { describe, expect, it, vi } from 'vitest';
import path from 'path';
import { ToolExecutor } from './executor';
import { EditorController } from '../../shared/editor/controller';
import type { ExportEventSink, ExportOptions } from '../media/exporter';

/**
 * An absolute output path, built from the platform's own root.
 *
 * The tool guards `outputPath` with `path.isAbsolute`, which is the correct
 * platform-native check. A hardcoded `C:\out\reel.mp4` satisfies it on Windows
 * and is a single RELATIVE segment on POSIX, so on Linux every test here failed
 * at the guard with "outputPath must be an absolute path." and none of them ever
 * reached the behaviour they were written to pin. The path is a value the tool
 * only ever passes through, so building it per platform tests the same contract
 * everywhere instead of testing the host OS.
 */
const OUT = path.resolve(path.sep, 'out', 'reel.mp4');

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
      outputPath: OUT,
      format: 'mov',
      quality: 'high',
    });

    expect(result.success).toBe(true);
    expect(captured).toMatchObject({ outputPath: OUT, format: 'mov', quality: 'high' });
    expect(result.data).toMatchObject({ bytes: 1234, format: 'mov', quality: 'high' });
  });

  it('surfaces an exporter error event even when the run resolves', async () => {
    const runExport = vi.fn(async (_project, _options: ExportOptions, sink: ExportEventSink) => {
      sink.send('export:error', 'Media offline: clip.mp4. Relink or remove it before exporting.');
    });
    const { executor } = harness(runExport);

    const result = await executor.execute('export_project', {
      outputPath: OUT,
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
      outputPath: OUT,
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

    await executor.execute('export_project', { outputPath: OUT });

    expect(captured).toMatchObject({ format: 'mp4', quality: 'normal' });
  });

  // ─── HDR profile (#59) ────────────────────────────────────────────────────

  it('passes an HDR profile through to the exporter and receipts it', async () => {
    let captured: ExportOptions | null = null;
    const runExport = vi.fn(async (_project, options: ExportOptions, sink: ExportEventSink) => {
      captured = options;
      sink.send('export:complete', { outputPath: options.outputPath, bytes: 4242 });
    });
    const { executor } = harness(runExport);

    const result = await executor.execute('export_project', {
      outputPath: OUT,
      format: 'mov',
      quality: 'high',
      hdr: 'hlg',
    });

    expect(result.success).toBe(true);
    expect(captured).toMatchObject({ format: 'mov', quality: 'high', hdr: 'hlg' });
    expect(result.data).toMatchObject({ bytes: 4242, hdr: 'hlg' });
  });

  it('accepts an explicit SDR profile as a passthrough', async () => {
    let captured: ExportOptions | null = null;
    const runExport = vi.fn(async (_project, options: ExportOptions, sink: ExportEventSink) => {
      captured = options;
      sink.send('export:complete', { outputPath: options.outputPath, bytes: 1 });
    });
    const { executor } = harness(runExport);

    const result = await executor.execute('export_project', {
      outputPath: OUT,
      hdr: 'sdr',
    });

    expect(result.success).toBe(true);
    expect(captured).toMatchObject({ hdr: 'sdr' });
    expect(result.data).toMatchObject({ hdr: 'sdr' });
  });

  it('clears hdr from options and receipt when it is not provided', async () => {
    let captured: ExportOptions | null = null;
    const runExport = vi.fn(async (_project, options: ExportOptions, sink: ExportEventSink) => {
      captured = options;
      sink.send('export:complete', { outputPath: options.outputPath, bytes: 1 });
    });
    const { executor } = harness(runExport);

    const result = await executor.execute('export_project', {
      outputPath: OUT,
    });

    expect(result.success).toBe(true);
    expect(captured).not.toHaveProperty('hdr');
    expect(result.data).not.toHaveProperty('hdr');
  });

  it('refuses an unknown HDR profile before starting a render', async () => {
    const runExport = vi.fn(async () => {});
    const { executor } = harness(runExport);

    const result = await executor.execute('export_project', {
      outputPath: OUT,
      hdr: 'blue',
    });

    expect(result.success).toBe(false);
    expect((result as { error?: string }).error).toMatch(/validation error/i);
    expect(runExport).not.toHaveBeenCalled();
  });

  it('refuses a non-string HDR profile before starting a render', async () => {
    const runExport = vi.fn(async () => {});
    const { executor } = harness(runExport);

    const result = await executor.execute('export_project', {
      outputPath: OUT,
      hdr: 42,
    });

    expect(result.success).toBe(false);
    expect((result as { error?: string }).error).toMatch(/validation error/i);
    expect(runExport).not.toHaveBeenCalled();
  });
});
