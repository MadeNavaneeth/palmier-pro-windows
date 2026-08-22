import { describe, it, expect } from 'vitest';
import { filmstripLayout } from './filmstrip';

describe('filmstripLayout', () => {
  it('keeps samples inside the window and positions them proportionally', () => {
    // 4 samples across a 10s source: centers at 1.25s, 3.75s, 6.25s, 8.75s.
    const slots = filmstripLayout(4, 10, 2.5, 7.5);
    // Only the two middle samples fall inside [2.5, 7.5).
    expect(slots).toEqual([
      { index: 1, leftRatio: 0.25 },
      { index: 2, leftRatio: 0.75 },
    ]);
  });

  it('returns every sample for a full-length window', () => {
    const slots = filmstripLayout(3, 9, 0, 9);
    expect(slots.map((s) => s.index)).toEqual([0, 1, 2]);
    expect(slots.map((s) => s.leftRatio)).toEqual([1 / 6, 0.5, 5 / 6]);
  });

  it('handles empty and degenerate windows', () => {
    expect(filmstripLayout(4, 10, 5, 5)).toEqual([]);
    expect(filmstripLayout(4, 0, 0, 1)).toEqual([]);
    // Window past the end keeps nothing.
    expect(filmstripLayout(4, 10, 11, 12)).toEqual([]);
  });
});
