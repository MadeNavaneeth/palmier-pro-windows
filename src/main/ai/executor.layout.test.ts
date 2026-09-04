/**
 * apply_layout over the full layout catalogue (upstream `VideoLayout` /
 * `apply_layout`): the tool reaches every preset, reports the slots the
 * preset defines, and refuses a name outside the catalogue at the schema
 * boundary.
 */
import { describe, it, expect } from 'vitest';
import { ToolExecutor } from './executor';
import { EditorController } from '../../shared/editor/controller';
import { VIDEO_LAYOUT_PRESETS } from '../../shared/editor/grid-layout';
import { tools } from './tools';

function harness(clipCount: number) {
  const editor = new EditorController();
  const clipIds: string[] = [];
  for (let i = 0; i < clipCount; i++) {
    const assetId = `v${i}`;
    editor.addMedia({
      id: assetId, path: `X:/${assetId}.mp4`, filename: `${assetId}.mp4`, type: 'video',
      duration: 60, width: 1920, height: 1080, fileSize: 1,
      addedAt: new Date().toISOString(),
    });
    // One clip per track: clips stacked on one track would occlude each other,
    // which is the arrangement a layout is meant to avoid.
    const trackId = i === 0 ? 'v1' : editor.addTrack('video');
    clipIds.push(editor.addClip({ assetId, trackId, startFrame: 0, durationFrames: 60 })!);
  }
  return { editor, executor: new ToolExecutor(editor), clipIds };
}

describe('apply_layout (upstream VideoLayout catalogue)', () => {
  it('publishes every preset through tool discovery', () => {
    const preset = tools.applyLayout.parameters.shape.preset;
    expect(preset.options).toEqual([...VIDEO_LAYOUT_PRESETS]);
  });

  it('accepts each catalogue preset and reports the slots it filled', async () => {
    for (const preset of VIDEO_LAYOUT_PRESETS) {
      const { executor, clipIds } = harness(16);

      const result = await executor.execute('apply_layout', {
        clipIds: clipIds,
        preset,
      });

      expect(result.success, preset).toBe(true);
      const data = result.data as { preset: string; slots: string[]; clipsArranged: number; requested: number };
      expect(data.preset, preset).toBe(preset);
      expect(data.requested, preset).toBe(16);
      expect(data.slots.length, preset).toBeGreaterThan(0);
      // A layout never places more clips than it has slots for; the surplus is
      // left where it was rather than stacked on the last cell.
      expect(data.clipsArranged, preset).toBe(Math.min(16, data.slots.length));
      expect(data.slots, preset).toEqual([...new Set(data.slots)]);
    }
  });

  it('lays two clips side by side across the full frame', async () => {
    const { editor, executor, clipIds } = harness(2);

    const result = await executor.execute('apply_layout', {
      clipIds, preset: 'side_by_side',
    });

    expect(result.success).toBe(true);
    const [left, right] = clipIds.map((id) => editor.getClips().find((c) => c.id === id)!);
    expect(left).toMatchObject({ x: 0, y: 0, width: 960, height: 1080 });
    expect(right).toMatchObject({ x: 960, y: 0, width: 960, height: 1080 });
  });

  it('puts the PiP inset clip on top of the main clip', async () => {
    const { editor, executor, clipIds } = harness(2);

    const result = await executor.execute('apply_layout', {
      clipIds, preset: 'pip_bottom_right',
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ slots: ['main', 'inset'], clipsArranged: 2 });
    const main = editor.getClips().find((c) => c.id === clipIds[0])!;
    const inset = editor.getClips().find((c) => c.id === clipIds[1])!;
    expect(main).toMatchObject({ width: 1920, height: 1080 });
    // 28% of the frame, 3.5% in from the bottom-right corner.
    expect(inset).toMatchObject({ x: 1315, y: 740, width: 538, height: 302 });
    expect(inset.x + inset.width).toBeLessThanOrEqual(1920);
    expect(inset.y + inset.height).toBeLessThanOrEqual(1080);
  });

  it('refuses a layout name outside the catalogue', async () => {
    const { executor, clipIds } = harness(2);

    const result = await executor.execute('apply_layout', {
      clipIds, preset: 'mosaic',
    });

    expect(result.success).toBe(false);
    // Upstream answers an unknown layout by naming the valid ones; the enum
    // rejection carries the same catalogue.
    expect(result.error).toContain("received 'mosaic'");
    for (const preset of VIDEO_LAYOUT_PRESETS) {
      expect(result.error, preset).toContain(preset);
    }
  });

  it('refuses an empty clip list at the schema boundary', async () => {
    const { executor } = harness(2);

    const result = await executor.execute('apply_layout', {
      clipIds: [], preset: 'full',
    });

    expect(result.success).toBe(false);
  });
});
