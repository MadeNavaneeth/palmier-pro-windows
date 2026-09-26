/**
 * generate_media reference images: the dormant GenerationRequest field is now
 * reachable from the agent, validated at the boundary, refused there when the
 * model cannot honour it, and recorded on the imported asset as provenance.
 *
 * Real ffprobe runs for the completed path, so the timeout is explicit.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { EditorController } from '../../shared/editor/controller';
import { setGenerationProviders } from '../generation/manager';
import type { GenerationProvider, GenerationRequest } from '../generation/types';
import { ToolExecutor, validateReferenceImage } from './executor';
import { MAX_REFERENCE_IMAGE_BYTES } from './tools';

const REAL_PROCESS_TIMEOUT_MS = 30_000;

/** A 1x1 PNG: real bytes, so probing it behaves like any other still. */
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

describe('generate_media reference image', () => {
  let tmpDir: string;
  let referencePath: string;
  let outputPath: string;
  let seen: GenerationRequest[];

  beforeEach(async () => {
    setGenerationProviders([]);
    seen = [];
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'palmier-refgen-'));
    referencePath = path.join(tmpDir, 'reference.png');
    outputPath = path.join(tmpDir, 'generated.png');
    await fs.writeFile(referencePath, ONE_PIXEL_PNG);
    await fs.writeFile(outputPath, ONE_PIXEL_PNG);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    setGenerationProviders([]);
  });

  /** A provider that records the request it was handed, then completes. */
  function recordingProvider(): GenerationProvider {
    return {
      id: 'refgen',
      name: 'RefGen',
      supportedTypes: ['image', 'video', 'audio'],
      isConfigured: () => true,
      configure: () => {},
      getModels: () => ['ref-model'],
      generate: async (request) => {
        seen.push(request);
        return { id: request.id, status: 'completed', outputPath, durationSeconds: 0 };
      },
      cancel: async () => {},
    };
  }

  it('passes a valid reference to the provider and records it as provenance', async () => {
    const editor = new EditorController();
    const executor = new ToolExecutor(editor);
    setGenerationProviders([recordingProvider()]);

    const result = await executor.execute('generate_media', {
      type: 'image',
      prompt: 'a quiet harbour at dusk',
      providerId: 'refgen',
      referenceImagePath: referencePath,
    });

    expect(result.success).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].referenceImagePath).toBe(referencePath);

    const asset = editor.getMedia()[0];
    expect(asset.type).toBe('image');
    expect(asset.generatedBy).toEqual({
      provider: 'refgen',
      model: 'ref-model',
      referenceImagePath: referencePath,
    });
    // The receipt echoes it, so the model can confirm what the run used.
    expect(result.data).toMatchObject({ referenceImagePath: referencePath });
  }, REAL_PROCESS_TIMEOUT_MS);

  it('leaves the request and the provenance untouched when no reference is supplied', async () => {
    const editor = new EditorController();
    const executor = new ToolExecutor(editor);
    setGenerationProviders([recordingProvider()]);

    const result = await executor.execute('generate_media', {
      type: 'image',
      prompt: 'a quiet harbour at dusk',
      providerId: 'refgen',
    });

    expect(result.success).toBe(true);
    // Byte-identical to the pre-reference request: same fields, no new key.
    expect(Object.keys(seen[0]).sort()).toEqual([
      'durationSeconds', 'extra', 'height', 'id', 'negativePrompt', 'prompt', 'provider', 'type', 'width',
    ]);
    expect(editor.getMedia()[0].generatedBy).toEqual({ provider: 'refgen', model: 'ref-model' });
    expect(result.data).not.toHaveProperty('referenceImagePath');
  }, REAL_PROCESS_TIMEOUT_MS);

  describe('refusals reach no provider and leave the project alone', () => {
    const CASES: Array<{
      label: string;
      resolve(dir: string): string;
      prepare(dir: string, target: string): Promise<void>;
      reason: RegExp;
    }> = [
      {
        label: 'a missing file',
        resolve: (dir) => path.join(dir, 'absent.png'),
        prepare: async () => {},
        reason: /Reference image not found/,
      },
      {
        label: 'a relative path',
        resolve: () => path.join('references', 'relative.png'),
        prepare: async () => {},
        reason: /must be an absolute path/,
      },
      {
        label: 'a file that is not an image',
        resolve: (dir) => path.join(dir, 'notes.txt'),
        prepare: async (_dir, target) => { await fs.writeFile(target, 'not an image'); },
        reason: /must be one of \.png, \.jpg, \.jpeg, \.webp, \.gif, \.bmp/,
      },
      {
        label: 'an empty image file',
        resolve: (dir) => path.join(dir, 'empty.png'),
        prepare: async (_dir, target) => { await fs.writeFile(target, ''); },
        reason: /Reference image is empty/,
      },
      {
        label: 'an image over the size cap',
        resolve: (dir) => path.join(dir, 'huge.png'),
        prepare: async (_dir, target) => {
          await fs.writeFile(target, Buffer.alloc(MAX_REFERENCE_IMAGE_BYTES + 1));
        },
        reason: /the cap is 8 MB/,
      },
      {
        label: 'a directory',
        resolve: (dir) => path.join(dir, 'folder.png'),
        prepare: async (_dir, target) => { await fs.mkdir(target); },
        reason: /is not a file/,
      },
    ];

    it.each(CASES)('refuses $label', async ({ resolve: resolveCase, prepare, reason }) => {
      const target = resolveCase(tmpDir);
      await prepare(tmpDir, target);

      const editor = new EditorController();
      const executor = new ToolExecutor(editor);
      setGenerationProviders([recordingProvider()]);

      const result = await executor.execute('generate_media', {
        type: 'image',
        prompt: 'a quiet harbour at dusk',
        providerId: 'refgen',
        referenceImagePath: target,
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(reason);
      expect(seen).toHaveLength(0);
      expect(editor.getMedia()).toHaveLength(0);
    });
  });

  it('refuses a reference on a video generation rather than letting the provider drop it', async () => {
    const editor = new EditorController();
    const executor = new ToolExecutor(editor);
    setGenerationProviders([recordingProvider()]);

    const result = await executor.execute('generate_media', {
      type: 'video',
      prompt: 'slow push in on the harbour',
      providerId: 'refgen',
      referenceImagePath: referencePath,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('RefGen ref-model is a video model and reads no reference image');
    expect(result.error).toContain('would be ignored');
    expect(seen).toHaveLength(0);
    expect(editor.getMedia()).toHaveLength(0);
  });

  it('checks the resolved model before looking at the filesystem', () => {
    const video = validateReferenceImage(referencePath, {
      type: 'video',
      providerName: 'fal.ai',
      model: 'fal-ai/kling-video/v1/standard/text-to-video',
    });
    expect(video.ok).toBe(false);
    expect(video.ok === false && video.error).toContain('reads no reference image');

    const image = validateReferenceImage(`  ${referencePath}  `, {
      type: 'image',
      providerName: 'fal.ai',
      model: 'fal-ai/flux/dev',
    });
    expect(image).toEqual({ ok: true, path: referencePath });
  });
});
