/**
 * Regression coverage for frame decode addressing (upstream issue #68).
 *
 * These cover the cache identity and request validation, which are the parts
 * that can be exercised without invoking FFmpeg.
 */

import { describe, it, expect } from 'vitest';
import { FrameDecoder, decodeRequestKey, type DecodeRequest } from './frame-decoder';

const base: DecodeRequest = {
  assetPath: 'C:/media/clip.mp4',
  width: 1920,
  height: 1080,
  sourceSeconds: 12,
};

describe('decode request identity', () => {
  it('is stable for identical requests', () => {
    expect(decodeRequestKey(base)).toBe(decodeRequestKey({ ...base }));
  });

  it('separates requests that differ only by size', () => {
    // A project-settings change re-fits clips, so the same source time is
    // requested at a new size. Sharing a cache entry across sizes handed the
    // compositor a buffer whose length disagreed with the layer it described.
    const portrait = { ...base, width: 1080, height: 1920 };
    expect(decodeRequestKey(portrait)).not.toBe(decodeRequestKey(base));
  });

  it('separates requests that differ only by source time', () => {
    expect(decodeRequestKey({ ...base, sourceSeconds: 12.5 })).not.toBe(decodeRequestKey(base));
  });

  it('separates requests that differ only by asset', () => {
    expect(decodeRequestKey({ ...base, assetPath: 'C:/media/other.mp4' })).not.toBe(
      decodeRequestKey(base),
    );
  });

  it('addresses source time at millisecond resolution', () => {
    // Sub-millisecond jitter must not fragment the cache.
    expect(decodeRequestKey({ ...base, sourceSeconds: 12.00004 })).toBe(decodeRequestKey(base));
  });
});

describe('decode request validation', () => {
  const decoder = new FrameDecoder({ cacheSize: 4, concurrency: 1 });

  it.each([
    ['an empty path', { ...base, assetPath: '' }],
    ['a negative seek', { ...base, sourceSeconds: -1 }],
    ['a non-finite seek', { ...base, sourceSeconds: Number.NaN }],
    ['a zero width', { ...base, width: 0 }],
    ['a negative height', { ...base, height: -1080 }],
    ['a fractional size', { ...base, width: 640.5 }],
  ])('rejects %s without decoding', async (_label, request) => {
    await expect(decoder.getFrame(request as DecodeRequest)).resolves.toBeNull();
    expect(decoder.getCacheSize()).toBe(0);
  });

  it('ignores invalid prefetch requests instead of rejecting the batch', async () => {
    await expect(
      decoder.prefetch([{ ...base, assetPath: '' }, { ...base, width: 0 }]),
    ).resolves.toBeUndefined();
    expect(decoder.getCacheSize()).toBe(0);
  });
});
