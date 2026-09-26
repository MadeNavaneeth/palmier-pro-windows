import { describe, expect, it } from 'vitest';
import type { MediaProbeResult } from '../../main/ipc/media';
import type { MediaAsset } from '../../shared/types/project';
import { EditorController } from '../../shared/editor/controller';
import {
  generatedMediaAssetFromProbe,
  generationStartRequest,
  referenceImageChoices,
} from './GenerateDialog';

const probe: MediaProbeResult = {
  path: 'C:/generated/clip.mp4',
  filename: 'clip.mp4',
  type: 'video',
  duration: 5,
  fileSize: 1,
};

function asset(id: string, type: MediaAsset['type'], filename: string): MediaAsset {
  return {
    id,
    path: `C:/library/${filename}`,
    filename,
    type,
    duration: 0,
    fileSize: 1,
    addedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('GenerateDialog generated asset import', () => {
  it('carries provenance into the imported library asset', () => {
    const asset = generatedMediaAssetFromProbe(probe, {
      provider: 'test-provider',
      model: 'test-model',
    }, 30);
    const editor = new EditorController();
    editor.importMediaAssets([asset]);

    expect(asset.duration).toBe(150);
    expect(editor.getMedia()[0].generatedBy).toEqual({
      provider: 'test-provider',
      model: 'test-model',
    });
  });

  it('preserves a supplied cost and omits an unavailable or invalid cost', () => {
    const withCost = generatedMediaAssetFromProbe(probe, {
      provider: 'test-provider',
      model: 'test-model',
      costCredits: 12.5,
    }, 30);
    const withoutCost = generatedMediaAssetFromProbe(probe, {
      provider: 'test-provider',
      model: 'test-model',
      costCredits: Number.NaN,
    }, 30);

    expect(withCost.generatedBy?.costCredits).toBe(12.5);
    expect(withoutCost.generatedBy).not.toHaveProperty('costCredits');
  });

  it('records the reference image in provenance and omits an unselected one', () => {
    const attached = generatedMediaAssetFromProbe(probe, {
      provider: 'test-provider',
      model: 'test-model',
      referenceImagePath: 'C:/library/still.png',
    }, 30);
    const cleared = generatedMediaAssetFromProbe(probe, {
      provider: 'test-provider',
      model: 'test-model',
      referenceImagePath: '   ',
    }, 30);

    expect(attached.generatedBy?.referenceImagePath).toBe('C:/library/still.png');
    expect(cleared.generatedBy).not.toHaveProperty('referenceImagePath');
  });
});

describe('GenerateDialog reference image selection', () => {
  const still = asset('img-1', 'image', 'still.png');
  const clip = asset('vid-1', 'video', 'clip.mp4');
  const song = asset('aud-1', 'audio', 'song.wav');

  it('offers only library images, in library order', () => {
    expect(referenceImageChoices([clip, still, song])).toEqual([still]);
    expect(referenceImageChoices([])).toEqual([]);
  });

  it('sends the chosen asset path on generate and omits it once cleared', () => {
    const state = {
      type: 'image' as const,
      prompt: 'a quiet harbour at dusk',
      providerId: 'fal',
      modelId: 'fal-ai/flux/dev',
      durationSeconds: 5,
    };

    const attached = generationStartRequest({ ...state, referenceImagePath: still.path });
    expect(attached.referenceImagePath).toBe(still.path);
    expect(attached).toMatchObject({ type: 'image', prompt: state.prompt, provider: 'fal' });

    const cleared = generationStartRequest({ ...state, referenceImagePath: '' });
    // Byte-identical to a run from before the field existed: the key is absent.
    expect(cleared).not.toHaveProperty('referenceImagePath');
    expect(cleared).toEqual({
      type: 'image',
      prompt: state.prompt,
      provider: 'fal',
      extra: { model: 'fal-ai/flux/dev' },
    });
  });

  it('never sends a reference for a type whose models read no image', () => {
    const request = generationStartRequest({
      type: 'video',
      prompt: 'slow push in',
      providerId: 'fal',
      modelId: 'fal-ai/kling-video/v1/standard/text-to-video',
      durationSeconds: 8,
      referenceImagePath: still.path,
    });

    expect(request).not.toHaveProperty('referenceImagePath');
    expect(request).toEqual({
      type: 'video',
      prompt: 'slow push in',
      provider: 'fal',
      extra: { model: 'fal-ai/kling-video/v1/standard/text-to-video' },
      durationSeconds: 8,
    });
  });
});
