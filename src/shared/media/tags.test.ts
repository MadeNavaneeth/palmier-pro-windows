import { describe, expect, it } from 'vitest';
import type { MediaAsset } from '../types/project';
import { assetMatchesQuery, deriveTags } from './tags';

function asset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: 'a1',
    path: '/tmp/clip.mp4',
    filename: 'sunset-beach-4k_final.mp4',
    type: 'video',
    duration: 900,
    width: 3840,
    height: 2160,
    fps: 30,
    codec: 'h264',
    audioCodec: 'aac',
    fileSize: 1_000_000,
    addedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('deriveTags (#118)', () => {
  it('produces technical tags from dimensions, duration, and codecs', () => {
    const tags = deriveTags(asset());
    expect(tags).toContain('video');
    expect(tags).toContain('4k');
    expect(tags).toContain('landscape');
    // 900 frames at 30 fps = 30s → medium (15-60s)
    expect(tags).toContain('medium');
    expect(tags).toContain('h264');
    expect(tags).toContain('aac');
  });

  it('extracts filename keywords and de-dupes', () => {
    const tags = deriveTags(asset({ filename: 'beach-beach_SUNSET.mp4' }));
    // keywords are lower-cased, short tokens dropped, capped
    expect(tags).toContain('beach');
    expect(tags).toContain('sunset');
    expect(tags.filter((t) => t === 'beach')).toHaveLength(1);
  });

  it('drops low-signal keyword tokens', () => {
    const tags = deriveTags(asset({ filename: 'IMG_1234-AB.mp4' }));
    // 'img' is 3 chars so kept, numeric and 2-char dropped
    expect(tags).not.toContain('1234');
    expect(tags).not.toContain('ab');
  });

  it('labels ai-generated assets', () => {
    const tags = deriveTags(asset({ generatedBy: { provider: 'fal', model: 'flux' } }));
    expect(tags).toContain('ai-generated');
    expect(tags).toContain('fal');
  });

  it('is searchable via filename or tag substring', () => {
    const a = asset({ filename: 'interview-2024.mp4', width: 1920, height: 1080 });
    expect(assetMatchesQuery(a, 'interview')).toBe(true);
    expect(assetMatchesQuery(a, '1080p')).toBe(true);
    expect(assetMatchesQuery(a, 'landscape')).toBe(true);
    expect(assetMatchesQuery(a, 'h264')).toBe(true);
    expect(assetMatchesQuery(a, 'zzz')).toBe(false);
    expect(assetMatchesQuery(a, '')).toBe(true);
  });

  it('handles images without duration', () => {
    const tags = deriveTags(asset({ type: 'image', duration: 0, width: 1080, height: 1920 }));
    expect(tags).toContain('image');
    expect(tags).toContain('portrait');
    expect(tags).not.toContain('very-short');
  });
});
