/**
 * Regression coverage for the add_texts and set_title_text agent tools
 * (R3): multi-entry placement, style overrides, refusal messages, and
 * text-only edits that never touch timing.
 */

import { describe, it, expect } from 'vitest';
import { ToolExecutor } from './executor';
import { EditorController } from '../../shared/editor/controller';

function executorWithTracks() {
  const editor = new EditorController();
  return { editor, executor: new ToolExecutor(editor) };
}

describe('add_texts tool (R3)', () => {
  it('adds multiple titles and reports their ids', async () => {
    const { editor, executor } = executorWithTracks();
    const result = await executor.execute('add_texts', {
      entries: [
        { trackId: 'v1', startFrame: 0, durationFrames: 60, text: 'Opening title' },
        { trackId: 'v1', startFrame: 120, durationFrames: 90, text: 'Closing card' },
      ],
    });
    expect(result.success).toBe(true);
    const added = (result.data as { added: Array<{ text: string }> }).added;
    expect(added).toHaveLength(2);
    expect(editor.getClips().filter((c) => c.type === 'title')).toHaveLength(2);
  });

  it('applies fontSize/color via follow-up property edit', async () => {
    const { editor, executor } = executorWithTracks();
    await executor.execute('add_texts', {
      entries: [{
        trackId: 'v1', startFrame: 0, durationFrames: 30,
        text: 'Styled', fontSize: 72, color: '#ffcc00',
      }],
    });
    const clip = editor.getClips()[0];
    expect(clip.titleColor).toBe('#ffcc00');
    // titleSizeRatio = 72 / project height (1080)
    expect(clip.titleSizeRatio).toBeCloseTo(72 / 1080, 4);
  });

  it('reports partial success with per-entry errors', async () => {
    const { executor } = executorWithTracks();
    const result = await executor.execute('add_texts', {
      entries: [
        { trackId: 'ghost-track', startFrame: 0, durationFrames: 30, text: 'Bad' },
        { trackId: 'v1', startFrame: 0, durationFrames: 30, text: 'Good' },
      ],
    });
    expect(result.success).toBe(true);
    const data = result.data as { added: unknown[]; errors: string[] };
    expect(data.added).toHaveLength(1);
    expect(data.errors[0]).toMatch(/ghost-track/);
  });

  it('fails when every entry is invalid', async () => {
    const { executor } = executorWithTracks();
    const result = await executor.execute('add_texts', {
      entries: [{ trackId: 'nope', startFrame: 0, durationFrames: 30, text: 'X' }],
    });
    expect(result.success).toBe(false);
  });
});

describe('set_title_text tool (R3)', () => {
  it('updates text without touching timing', async () => {
    const { editor, executor } = executorWithTracks();
    const id = editor.addTitleClip({ trackId: 'v1', text: 'Before', startFrame: 50, durationFrames: 40 });
    const before = editor.getClips()[0];

    const result = await executor.execute('set_title_text', { clipId: id, text: 'After' });
    expect(result.success).toBe(true);

    const clip = editor.getClips().find((c) => c.id === id)!;
    expect(clip.text).toBe('After');
    expect(clip.startFrame).toBe(before.startFrame); // timing untouched
    expect(clip.durationFrames).toBe(before.durationFrames);
  });

  it('refuses empty or non-title clips', async () => {
    const { editor, executor } = executorWithTracks();
    editor.addClip({ assetId: 'x', trackId: 'v1', startFrame: 0 });

    expect((await executor.execute('set_title_text', { clipId: editor.getClips()[0].id, text: '' })).success)
      .toBe(false);
    expect((await executor.execute('set_title_text', { clipId: 'ghost', text: 'Hi' })).success)
      .toBe(false);
  });

  it('carries background box styling including padding (#507)', async () => {
    const { editor, executor } = executorWithTracks();
    await executor.execute('add_texts', {
      entries: [{
        trackId: 'v1', startFrame: 0, durationFrames: 30, text: 'Boxed',
        backgroundColor: '#00000080', backgroundPadding: 24,
      }],
    });
    const added = editor.getClips().find((c) => c.type === 'title')!;
    expect(added.titleBackgroundColor).toBe('#00000080');
    expect(added.titleBackgroundPadding).toBe(24);

    const id = editor.addTitleClip({ trackId: 'v1', text: 'Adjust', startFrame: 100, durationFrames: 30 });
    await executor.execute('set_title_text', { clipId: id, backgroundColor: null, backgroundPadding: 0 });
    const updated = editor.getClips().find((c) => c.id === id)!;
    expect(updated.titleBackgroundColor).toBeUndefined();
    expect(updated.titleBackgroundPadding).toBe(0);
  });

  it('carries line spacing and font case (#330)', async () => {
    const { editor, executor } = executorWithTracks();
    await executor.execute('add_texts', {
      entries: [{
        trackId: 'v1', startFrame: 0, durationFrames: 30, text: 'mixed case',
        lineSpacing: 10, fontCase: 'upper',
      }],
    });
    const added = editor.getClips().find((c) => c.type === 'title')!;
    // Case is a render-time transform: stored text stays as authored.
    expect(added.text).toBe('mixed case');
    expect(added.titleFontCase).toBe('upper');
    expect(added.titleLineSpacing).toBe(10);

    const id = editor.addTitleClip({ trackId: 'v1', text: 'Second', startFrame: 100, durationFrames: 30 });
    await executor.execute('set_title_text', { clipId: id, fontCase: 'lower', lineSpacing: 4 });
    const updated = editor.getClips().find((c) => c.id === id)!;
    expect(updated.titleFontCase).toBe('lower');
    expect(updated.titleLineSpacing).toBe(4);
  });

  it('carries fill mode and blur, clearing back to solid (#525/#529)', async () => {
    const { editor, executor } = executorWithTracks();
    await executor.execute('add_texts', {
      entries: [{
        trackId: 'v1', startFrame: 0, durationFrames: 30, text: 'Stencil',
        fillMode: 'footage', blurRadius: 6,
      }],
    });
    const added = editor.getClips().find((c) => c.type === 'title')!;
    expect(added.titleFillMode).toBe('footage');
    expect(added.titleBlurRadius).toBe(6);

    const id = editor.addTitleClip({ trackId: 'v1', text: 'Inv', startFrame: 100, durationFrames: 30 });
    await executor.execute('set_title_text', { clipId: id, fillMode: 'inverted', blurRadius: 3 });
    const inverted = editor.getClips().find((c) => c.id === id)!;
    expect(inverted.titleFillMode).toBe('inverted');
    expect(inverted.titleBlurRadius).toBe(3);

    await executor.execute('set_title_text', { clipId: id, fillMode: 'color', blurRadius: 0 });
    const cleared = editor.getClips().find((c) => c.id === id)!;
    expect(cleared.titleFillMode).toBeUndefined();
    expect(cleared.titleBlurRadius).toBeUndefined();
  });
});
