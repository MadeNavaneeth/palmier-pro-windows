import { describe, expect, it } from 'vitest';
import { supportsMediaAdjustmentControls } from './inspector-eligibility';

describe('supportsMediaAdjustmentControls', () => {
  it('keeps the adjustment block for decoded-media clips', () => {
    expect(supportsMediaAdjustmentControls('video')).toBe(true);
    expect(supportsMediaAdjustmentControls('image')).toBe(true);
    expect(supportsMediaAdjustmentControls('generated')).toBe(true);
  });

  it('hides the block for clips without a decoded-media adjustment path', () => {
    expect(supportsMediaAdjustmentControls('title')).toBe(false);
    expect(supportsMediaAdjustmentControls('audio')).toBe(false);
    expect(supportsMediaAdjustmentControls('shape')).toBe(false);
    expect(supportsMediaAdjustmentControls('compound')).toBe(false);
  });
});
