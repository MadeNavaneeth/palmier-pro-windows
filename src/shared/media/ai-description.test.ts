import { describe, expect, it } from 'vitest';
import type { MediaAsset } from '../types/project';
import { assetMatchesQuery } from './tags';
import {
  AI_DESCRIPTION_MAX_LENGTH,
  narrowAiDescription,
  sanitizeAiDescription,
} from './ai-description';

describe('sanitizeAiDescription (#118 AI half)', () => {
  it('accepts a plain sentence unchanged', () => {
    expect(sanitizeAiDescription('A red car parked by the beach.')).toBe(
      'A red car parked by the beach.',
    );
  });

  it('strips control characters and collapses whitespace', () => {
    expect(sanitizeAiDescription('  A\u0000red\n\ncar\t\tby  the   beach  ')).toBe(
      'A red car by the beach',
    );
  });

  it('caps length at 500 chars', () => {
    const long = 'x'.repeat(AI_DESCRIPTION_MAX_LENGTH + 50);
    const out = sanitizeAiDescription(long)!;
    expect(out).toHaveLength(AI_DESCRIPTION_MAX_LENGTH);
  });

  it('rejects empty, blank, and non-string input', () => {
    expect(sanitizeAiDescription('')).toBeNull();
    expect(sanitizeAiDescription('   ')).toBeNull();
    expect(sanitizeAiDescription(undefined)).toBeNull();
    expect(sanitizeAiDescription(42)).toBeNull();
    expect(sanitizeAiDescription(null)).toBeNull();
  });
});

describe('narrowAiDescription (#118 AI half)', () => {
  it('passes a valid stored description through sanitized', () => {
    expect(narrowAiDescription('A red car.')).toBe('A red car.');
  });

  it('degrades non-string and over-long values to absent', () => {
    expect(narrowAiDescription(undefined)).toBeUndefined();
    expect(narrowAiDescription(42)).toBeUndefined();
    expect(narrowAiDescription(null)).toBeUndefined();
    expect(narrowAiDescription('x'.repeat(AI_DESCRIPTION_MAX_LENGTH + 1))).toBeUndefined();
  });

  it('degrades blank stored values to absent without breaking load', () => {
    expect(narrowAiDescription('')).toBeUndefined();
    expect(narrowAiDescription('   ')).toBeUndefined();
  });
});

describe('description search (#118 AI half)', () => {
  function asset(overrides: Partial<MediaAsset> = {}): MediaAsset {
    return {
      id: 'a1',
      path: '/tmp/clip.mp4',
      filename: 'clip.mp4',
      type: 'video',
      duration: 300,
      fileSize: 1,
      addedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it('matches description substrings like tags (caller lower-cases the query)', () => {
    const a = asset({ aiDescription: 'A red car parked by the harbour at dusk.' });
    expect(assetMatchesQuery(a, 'red car')).toBe(true);
    expect(assetMatchesQuery(a, 'harbour')).toBe(true);
    expect(assetMatchesQuery(a, 'zzz')).toBe(false);
  });

  it('still matches tags when no description is stored', () => {
    const a = asset({ filename: 'interview.mp4' });
    expect(assetMatchesQuery(a, 'interview')).toBe(true);
    expect(assetMatchesQuery(a, 'harbour')).toBe(false);
  });
});
