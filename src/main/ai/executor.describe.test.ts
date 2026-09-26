/**
 * describe_media (#118 AI half): strict validation, stubbed vision transport
 * (no network), receipt shape, and the undoable media-field write.
 */
import { describe, expect, it, vi } from 'vitest';
import { ToolExecutor } from './executor';
import { EditorController } from '../../shared/editor/controller';

function editorWithAssets() {
  const editor = new EditorController();
  editor.addMedia({
    id: 'pic', path: 'D:/img/photo.png', filename: 'photo.png', type: 'image',
    duration: 0, fileSize: 1, addedAt: new Date().toISOString(),
  });
  editor.addMedia({
    id: 'song', path: 'D:/audio/song.wav', filename: 'song.wav', type: 'audio',
    duration: 100, fileSize: 1, addedAt: new Date().toISOString(),
  });
  return editor;
}

const RUNTIME = {
  kind: 'openai-compatible' as const,
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-4o',
  providerId: 'openai',
};

describe('describe_media', () => {
  it('stores the sanitized description as one undoable step with a truncated receipt', async () => {
    const editor = editorWithAssets();
    const describeImage = vi.fn(async () => ({
      description: 'A red car by the beach.',
      model: 'gpt-4o',
      provider: 'openai',
    }));
    const executor = new ToolExecutor(editor, {
      getVisionRuntime: async () => RUNTIME,
      describeImage,
    });

    const result = await executor.execute('describe_media', { assetId: 'pic' });
    expect(result.success).toBe(true);
    const data = result.data as {
      assetId: string; description: string; fullLength: number; provider: string; updated: boolean;
    };
    expect(data.assetId).toBe('pic');
    expect(data.description).toBe('A red car by the beach.');
    expect(data.provider).toBe('openai');
    expect(editor.getMedia().find((m) => m.id === 'pic')?.aiDescription).toBe(
      'A red car by the beach.',
    );
    expect(describeImage).toHaveBeenCalledOnce();

    // One user action = one undo step.
    editor.undo();
    expect(editor.getMedia().find((m) => m.id === 'pic')?.aiDescription).toBeUndefined();
  });

  it('truncates a long description in the receipt but stores it whole', async () => {
    const editor = editorWithAssets();
    // 460 chars, no trailing-space ambiguity (sanitize trims on write).
    const stored = 'A very detailed scene.'.repeat(20);
    const executor = new ToolExecutor(editor, {
      getVisionRuntime: async () => RUNTIME,
      describeImage: async () => ({ description: stored, model: 'gpt-4o', provider: 'openai' }),
    });
    const result = await executor.execute('describe_media', { assetId: 'pic' });
    expect(result.success).toBe(true);
    const data = result.data as { description: string; fullLength: number };
    expect(data.description.length).toBeLessThanOrEqual(201); // 200 + ellipsis
    expect(data.fullLength).toBe(stored.length);
    expect(editor.getMedia().find((m) => m.id === 'pic')?.aiDescription).toBe(stored);
  });

  it('refuses unknown assets', async () => {
    const editor = editorWithAssets();
    const executor = new ToolExecutor(editor, {
      getVisionRuntime: async () => RUNTIME,
      describeImage: async () => ({ description: 'x', model: 'm', provider: 'p' }),
    });
    const result = await executor.execute('describe_media', { assetId: 'ghost' });
    expect(result.success).toBe(false);
    expect((result as { error?: string }).error).toBe('Asset not found.');
  });

  it('refuses audio assets without calling the provider', async () => {
    const editor = editorWithAssets();
    const describeImage = vi.fn();
    const executor = new ToolExecutor(editor, {
      getVisionRuntime: async () => RUNTIME,
      describeImage,
    });
    const result = await executor.execute('describe_media', { assetId: 'song' });
    expect(result.success).toBe(false);
    expect((result as { error?: string }).error).toMatch(/no frames/i);
    expect(describeImage).not.toHaveBeenCalled();
  });

  it('refuses cleanly when no vision runtime is configured', async () => {
    const editor = editorWithAssets();
    const executor = new ToolExecutor(editor, {
      getVisionRuntime: async () => null,
    });
    const result = await executor.execute('describe_media', { assetId: 'pic' });
    expect(result.success).toBe(false);
    expect((result as { error?: string }).error).toMatch(/no vision-capable/i);
  });

  it('surfaces transport failures without writing', async () => {
    const editor = editorWithAssets();
    const executor = new ToolExecutor(editor, {
      getVisionRuntime: async () => RUNTIME,
      describeImage: async () => {
        throw new Error('429 rate limited');
      },
    });
    const result = await executor.execute('describe_media', { assetId: 'pic' });
    expect(result.success).toBe(false);
    expect((result as { error?: string }).error).toContain('429');
    expect(editor.getMedia().find((m) => m.id === 'pic')?.aiDescription).toBeUndefined();
  });
});
