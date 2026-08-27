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
import { EditorController } from '../../shared/editor/controller';
import type { GenerationProvider } from '../../main/generation/types';
import { setGenerationProviders } from '../../main/generation/manager';

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
    // Provenance reaches the model so it can reference the asset later.
    expect(result.data).toMatchObject({
      assetId: assets[0].id,
      provider: 'fakegen',
      model: 'fake-model',
    });
  });

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
  });

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
