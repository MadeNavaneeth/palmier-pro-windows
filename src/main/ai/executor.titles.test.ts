/**
 * Regression coverage for the add_texts and set_title_text agent tools
 * (R3): multi-entry placement, style overrides, refusal messages, and
 * text-only edits that never touch timing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { ToolExecutor } from './executor';
import { parseToolArguments } from './openai-compatible';
import { EditorController } from '../../shared/editor/controller';
import { DEFAULT_TITLE_STYLE } from '../../shared/editor/title';
import type { GenerationProvider } from '../../main/generation/types';
import { setGenerationProviders } from '../../main/generation/manager';
import {
  assetDurationSeconds,
  isSourceSeekable,
  sourceSecondsForTimelineFrame,
} from '../../shared/media/source-time';

// Real ffprobe calls are subprocess-bound; keep their timeout explicit so a
// loaded parallel run does not inherit the 5 s default used by fast unit tests.
const REAL_PROCESS_TIMEOUT_MS = 30_000;

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
    await executor.execute('set_title_text', parseToolArguments(JSON.stringify({
      clipId: id, backgroundColor: null, backgroundPadding: 0,
    })));
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

  it('carries perspective tilt with 0-clears semantics (#519)', async () => {
    const { editor, executor } = executorWithTracks();
    await executor.execute('add_texts', {
      entries: [{
        trackId: 'v1', startFrame: 0, durationFrames: 30, text: 'Tilted',
        tiltX: -18, tiltY: 24,
      }],
    });
    const added = editor.getClips().find((c) => c.type === 'title')!;
    expect(added.titleTiltXDeg).toBe(-18);
    expect(added.titleTiltYDeg).toBe(24);

    const id = editor.addTitleClip({ trackId: 'v1', text: 'Flat', startFrame: 100, durationFrames: 30 });
    await executor.execute('set_title_text', { clipId: id, tiltX: 10, tiltY: -5 });
    const tilted = editor.getClips().find((c) => c.id === id)!;
    expect(tilted.titleTiltXDeg).toBe(10);
    expect(tilted.titleTiltYDeg).toBe(-5);

    await executor.execute('set_title_text', { clipId: id, tiltX: 0, tiltY: 0 });
    const cleared = editor.getClips().find((c) => c.id === id)!;
    expect(cleared.titleTiltXDeg).toBeUndefined();
    expect(cleared.titleTiltYDeg).toBeUndefined();
  });

  it('carries variable-font axes with default-clears semantics (#50)', async () => {
    const { editor, executor } = executorWithTracks();
    const added = await executor.execute('add_texts', {
      entries: [{
        trackId: 'v1', startFrame: 0, durationFrames: 30, text: 'Heavy',
        variationWght: 800, variationWdth: 75, variationSlnt: -12, variationItal: 1,
      }],
    });
    expect(added.success).toBe(true);
    const clip = editor.getClips().find((c) => c.type === 'title')!;
    expect(clip.titleVariationWght).toBe(800);
    expect(clip.titleVariationWdth).toBe(75);
    expect(clip.titleVariationSlnt).toBe(-12);
    expect(clip.titleVariationItal).toBe(1);

    // The style edit is one undo step reporting the updated clip.
    const updated = await executor.execute('set_title_text', { clipId: clip.id, variationWght: 600 });
    expect(updated.success).toBe(true);
    expect(updated.data).toEqual({ updated: clip.id });
    expect(editor.getClips().find((c) => c.id === clip.id)!.titleVariationWght).toBe(600);
    expect(editor.undo()).toBe(true);
    expect(editor.getClips().find((c) => c.id === clip.id)!.titleVariationWght).toBe(800);

    // Defaults clear back to absent, like blur/tilt zeros.
    await executor.execute('set_title_text', {
      clipId: clip.id,
      variationWght: 400, variationWdth: 100, variationSlnt: 0, variationItal: 0,
    });
    const cleared = editor.getClips().find((c) => c.id === clip.id)!;
    expect(cleared.titleVariationWght).toBeUndefined();
    expect(cleared.titleVariationWdth).toBeUndefined();
    expect(cleared.titleVariationSlnt).toBeUndefined();
    expect(cleared.titleVariationItal).toBeUndefined();
  });

  it('refuses out-of-range axes and changes nothing (#50)', async () => {
    const { editor, executor } = executorWithTracks();
    await executor.execute('add_texts', {
      entries: [{ trackId: 'v1', startFrame: 0, durationFrames: 30, text: 'Plain' }],
    });
    const clip = editor.getClips().find((c) => c.type === 'title')!;

    expect((await executor.execute('set_title_text', { clipId: clip.id, variationWght: 2000 })).success)
      .toBe(false);
    expect((await executor.execute('set_title_text', { clipId: clip.id, variationWdth: 10 })).success)
      .toBe(false);
    expect((await executor.execute('set_title_text', { clipId: clip.id, variationSlnt: 120 })).success)
      .toBe(false);
    expect((await executor.execute('set_title_text', { clipId: clip.id, variationItal: 2 })).success)
      .toBe(false);
    const untouched = editor.getClips().find((c) => c.id === clip.id)!;
    expect(untouched.titleVariationWght).toBeUndefined();
    expect(untouched.titleVariationWdth).toBeUndefined();
    expect(untouched.titleVariationSlnt).toBeUndefined();
    expect(untouched.titleVariationItal).toBeUndefined();
  });

  // ─── Clip resolution, truthful receipts, and one-call-one-undo ─────────────

  /**
   * Undo everything left and report how many steps that took. Placement
   * (addTitleClip/addClip) is itself a history entry, so the counts below are
   * "one more than the placements" when a call published, and exactly the
   * placements when it did not.
   */
  function undoStepsLeft(editor: EditorController): number {
    let steps = 0;
    while (editor.undo()) steps += 1;
    return steps;
  }

  it('refuses a non-title clip whether or not text is passed', async () => {
    const { editor, executor } = executorWithTracks();
    editor.addClip({ assetId: 'x', trackId: 'v1', startFrame: 0 });
    const id = editor.getClips()[0].id;

    // Style-only used to reach the mutator with no guard: the batch skipped the
    // clip and the tool still answered success:true with nothing changed.
    const styleOnly = await executor.execute('set_title_text', { clipId: id, color: '#ff0000' });
    expect(styleOnly.success).toBe(false);
    expect((styleOnly as { error?: string }).error).toMatch(/only title clips/i);

    const withText = await executor.execute('set_title_text', { clipId: id, text: 'Nope' });
    expect(withText.success).toBe(false);
    expect((withText as { error?: string }).error).toMatch(/only title clips/i);

    expect(editor.getClips()[0].titleColor).toBeUndefined();
    // Both refusals published nothing: only the placement is left to undo.
    expect(undoStepsLeft(editor)).toBe(1);
  });

  it('refuses a missing clip with a clip-specific message', async () => {
    const { executor } = executorWithTracks();
    const result = await executor.execute('set_title_text', { clipId: 'ghost', color: '#ff0000' });
    expect(result.success).toBe(false);
    expect((result as { error?: string }).error).toBe('Clip not found.');
  });

  it('reports changed:false when the style batch lands nothing', async () => {
    const { editor, executor } = executorWithTracks();
    const id = editor.addTitleClip({ trackId: 'v1', text: 'Same', startFrame: 0, durationFrames: 30 });

    const result = await executor.execute('set_title_text', { clipId: id, text: 'Same' });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ updated: id, changed: false });

    // A style field that matches the current value is the same no-op.
    const styled = await executor.execute('set_title_text', {
      clipId: id, color: editor.getClips()[0].titleColor,
    });
    expect(styled.success).toBe(true);
    expect(styled.data).toEqual({ updated: id, changed: false });

    // Neither call published anything: only the placement is left to undo.
    expect(undoStepsLeft(editor)).toBe(1);
  });

  it('publishes text and style as one undo step', async () => {
    const { editor, executor } = executorWithTracks();
    const id = editor.addTitleClip({ trackId: 'v1', text: 'Before', startFrame: 0, durationFrames: 30 });

    const result = await executor.execute('set_title_text', {
      clipId: id, text: 'After', color: '#00ff00', fontSize: 90,
    });
    expect(result.success).toBe(true);
    const updated = editor.getClips().find((c) => c.id === id)!;
    expect(updated.text).toBe('After');
    expect(updated.titleColor).toBe('#00ff00');
    expect(updated.titleSizeRatio).toBeCloseTo(90 / 1080, 4);

    // ONE undo reverts both edits …
    expect(editor.undo()).toBe(true);
    const reverted = editor.getClips().find((c) => c.id === id)!;
    expect(reverted.text).toBe('Before');
    expect(reverted.titleColor).toBe(DEFAULT_TITLE_STYLE.colorHex);
    expect(reverted.titleSizeRatio).toBeCloseTo(DEFAULT_TITLE_STYLE.sizeRatio, 4);
    // … and only the placement remains, so the call was a single step.
    expect(undoStepsLeft(editor)).toBe(1);
  });

  it('keeps a text-only call on its existing single history step', async () => {
    const { editor, executor } = executorWithTracks();
    const id = editor.addTitleClip({ trackId: 'v1', text: 'Solo', startFrame: 0, durationFrames: 30 });

    await executor.execute('set_title_text', { clipId: id, text: 'Solo 2' });
    expect(editor.undo()).toBe(true);
    expect(editor.getClips().find((c) => c.id === id)!.text).toBe('Solo');
    expect(undoStepsLeft(editor)).toBe(1);
  });

  it('keeps a style-only call on its existing single history step', async () => {
    const { editor, executor } = executorWithTracks();
    const id = editor.addTitleClip({ trackId: 'v1', text: 'Solo', startFrame: 0, durationFrames: 30 });

    await executor.execute('set_title_text', { clipId: id, color: '#123456' });
    expect(editor.getClips().find((c) => c.id === id)!.titleColor).toBe('#123456');
    expect(editor.undo()).toBe(true);
    expect(editor.getClips().find((c) => c.id === id)!.titleColor).toBe(DEFAULT_TITLE_STYLE.colorHex);
    expect(undoStepsLeft(editor)).toBe(1);
  });
});


// ─── generate_media (PR #406 registry wiring) ────────────────────────────────

/** A minimal valid mono 16-bit WAV so ffprobe can read real metadata. */
function makeWav(seconds = 1, sampleRate = 8000): Buffer {
  const dataSize = Math.floor(sampleRate * seconds) * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

describe('generate_media tool (PR #406 registry wiring)', () => {
  let tmpDir: string;
  beforeEach(() => {
    setGenerationProviders([]);
    tmpDir = '';
  });
  afterEach(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
    setGenerationProviders([]);
  });

  function providerReturning(outputPath: string | Error): GenerationProvider {
    return {
      id: 'fakegen',
      name: 'FakeGen',
      supportedTypes: ['image', 'video', 'audio'],
      isConfigured: () => true,
      configure: () => {},
      getModels: () => ['fake-model'],
      generate: async (request) => {
        if (outputPath instanceof Error) throw outputPath;
        return {
          id: request.id,
          status: 'completed',
          outputPath,
          durationSeconds: 1,
        };
      },
      cancel: async () => {},
    };
  }

  function providerWith(overrides: Partial<GenerationProvider>): GenerationProvider {
    return { ...providerReturning(''), ...overrides } as GenerationProvider;
  }

  it('imports the generated file as a library asset with provenance', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'palmier-gen-'));
    const wavPath = path.join(tmpDir, 'out.wav');
    await fs.writeFile(wavPath, makeWav());

    const editor = new EditorController();
    const executor = new ToolExecutor(editor);
    setGenerationProviders([providerReturning(wavPath)]);

    const result = await executor.execute('generate_media', {
      type: 'audio',
      prompt: 'gentle rain',
      providerId: 'fakegen',
      durationSeconds: 1,
    });

    expect(result.success).toBe(true);
    const assets = editor.getMedia();
    expect(assets).toHaveLength(1);
    expect(assets[0].path).toBe(wavPath);
    expect(assets[0].type).toBe('audio');
    expect(assets[0].duration).toBe(30);
    expect(assets[0].generatedBy).toEqual({ provider: 'fakegen', model: 'fake-model' });
    expect(assets[0].generatedBy).not.toHaveProperty('costCredits');
    // Provenance reaches the model so it can reference the asset later.
    expect(result.data).toMatchObject({
      assetId: assets[0].id,
      provider: 'fakegen',
      model: 'fake-model',
    });
  }, REAL_PROCESS_TIMEOUT_MS);

  it('converts a 5-second probe to project frames so its default clip plays fully', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'palmier-gen-'));
    const wavPath = path.join(tmpDir, 'five-seconds.wav');
    await fs.writeFile(wavPath, makeWav(5));

    const editor = new EditorController();
    const executor = new ToolExecutor(editor);
    setGenerationProviders([providerReturning(wavPath)]);

    const result = await executor.execute('generate_media', {
      type: 'audio',
      prompt: 'five second tone',
      providerId: 'fakegen',
      durationSeconds: 5,
    });
    expect(result.success).toBe(true);

    const fps = editor.getProject().settings.fps;
    const asset = editor.getMedia()[0];
    expect(asset.duration).toBe(5 * fps);
    expect(assetDurationSeconds(asset, fps)).toBe(5);

    const clipId = editor.addClip({ assetId: asset.id, trackId: 'a1', startFrame: 0 });
    const clip = editor.getClips().find((candidate) => candidate.id === clipId)!;
    expect(clip.durationFrames).toBe(asset.duration);
    expect(clip.outPoint).toBe(asset.duration);
    const lastFrameSeconds = sourceSecondsForTimelineFrame(
      clip,
      clip.startFrame + clip.durationFrames - 1,
      fps,
    );
    expect(isSourceSeekable(lastFrameSeconds, assetDurationSeconds(asset, fps))).toBe(true);
  }, REAL_PROCESS_TIMEOUT_MS);

  it('populates generatedBy with provider, model, and costCredits on the asset (upstream #570)', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'palmier-gen-'));
    const wavPath = path.join(tmpDir, 'out.wav');
    await fs.writeFile(wavPath, makeWav());

    const editor = new EditorController();
    const executor = new ToolExecutor(editor);

    setGenerationProviders([{
      id: 'costlygen',
      name: 'CostlyGen',
      supportedTypes: ['image', 'video', 'audio'],
      isConfigured: () => true,
      configure: () => {},
      getModels: () => ['costly-model-v2'],
      generate: async (request) => ({
        id: request.id,
        status: 'completed',
        outputPath: wavPath,
        durationSeconds: 1,
        costCredits: 42,
      }),
      cancel: async () => {},
    }]);

    const result = await executor.execute('generate_media', {
      type: 'audio', prompt: 'test', providerId: 'costlygen', durationSeconds: 1,
    });

    expect(result.success).toBe(true);
    const asset = editor.getMedia()[0];
    expect(asset.generatedBy).toEqual({
      provider: 'costlygen',
      model: 'costly-model-v2',
      costCredits: 42,
    });

    const json = editor.serialize();
    const restored = new EditorController(JSON.parse(json));
    expect(restored.getMedia()[0].generatedBy).toEqual({
      provider: 'costlygen',
      model: 'costly-model-v2',
      costCredits: 42,
    });
  }, REAL_PROCESS_TIMEOUT_MS);

  it('surfaces a provider failure as a failed tool call', async () => {
    const editor = new EditorController();
    const executor = new ToolExecutor(editor);
    setGenerationProviders([
      providerReturning(new Error('GPU quota exhausted')),
    ]);

    const result = await executor.execute('generate_media', {
      type: 'video', prompt: 'ocean', providerId: 'fakegen',
    });

    expect(result.success).toBe(false);
    expect((result as { error?: string }).error).toContain('GPU quota exhausted');
    expect(editor.getMedia()).toHaveLength(0);
  });

  it('does not import a cancelled generation', async () => {
    const editor = new EditorController();
    const executor = new ToolExecutor(editor);
    setGenerationProviders([
      providerWith({
        id: 'cancelledgen',
        generate: async (request) => ({
          id: request.id,
          status: 'cancelled',
          error: 'Generation cancelled',
        }),
      }),
    ]);

    const result = await executor.execute('generate_media', {
      type: 'image', prompt: 'discarded', providerId: 'cancelledgen',
    });

    expect(result.success).toBe(false);
    expect((result as { error?: string }).error).toContain('cancelled');
    expect(editor.getMedia()).toHaveLength(0);
  });

  it('refuses before generating when no configured provider supports the type', async () => {
    const editor = new EditorController();
    const executor = new ToolExecutor(editor);
    setGenerationProviders([
      providerWith({ id: 'img-only', supportedTypes: ['image'] }),
    ]);
    // The fake defaults to isConfigured:true; make the refusal case honest by
    // clearing support rather than keys.

    const result = await executor.execute('generate_media', {
      type: 'audio', prompt: 'birds', providerId: 'img-only',
    });

    expect(result.success).toBe(false);
    expect((result as { error?: string }).error).toContain('No generation provider');
    expect(editor.getMedia()).toHaveLength(0);
  });
});
