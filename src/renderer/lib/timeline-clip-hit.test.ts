/**
 * Regression coverage for narrow-clip hit-testing (upstream PR #488).
 *
 * The defect: trim zones are fixed 6 px strips, but clips render as narrow as
 * 4 px, so on a short clip the two trim zones overlapped and covered the whole
 * body — every mouse-down trimmed and the clip could never be moved.
 */

import { describe, it, expect } from 'vitest';
import {
  MIN_PRECISION_CLIP_WIDTH,
  TRIM_HANDLE_WIDTH,
  resolveClipHitZone,
  showsTrimHandles,
} from './timeline-clip-hit';

describe('resolveClipHitZone', () => {
  it('returns the left trim zone at or under the handle width', () => {
    expect(resolveClipHitZone(0, 200)).toBe('trim-left');
    expect(resolveClipHitZone(TRIM_HANDLE_WIDTH, 200)).toBe('trim-left');
  });

  it('returns the right trim zone at or past width minus the handle width', () => {
    expect(resolveClipHitZone(194, 200)).toBe('trim-right');
    expect(resolveClipHitZone(200, 200)).toBe('trim-right');
  });

  it('returns the body between the handles', () => {
    expect(resolveClipHitZone(100, 200)).toBe('body');
    expect(resolveClipHitZone(TRIM_HANDLE_WIDTH + 1, 200)).toBe('body');
    expect(resolveClipHitZone(193, 200)).toBe('body');
  });

  it('keeps a narrow clip entirely a move surface (#488)', () => {
    // Every pixel of a sub-minimum clip must be body, including the edges
    // where the trim zones used to win.
    for (const width of [4, 7, 11, MIN_PRECISION_CLIP_WIDTH - 1]) {
      for (const localX of [0, 3, width / 2, width - 1, width]) {
        expect(resolveClipHitZone(localX, width), `width=${width} localX=${localX}`).toBe('body');
      }
    }
  });

  it('restores precision controls once the clip is wide enough', () => {
    expect(resolveClipHitZone(0, MIN_PRECISION_CLIP_WIDTH)).toBe('trim-left');
    expect(resolveClipHitZone(MIN_PRECISION_CLIP_WIDTH, MIN_PRECISION_CLIP_WIDTH))
      .toBe('trim-right');
    expect(resolveClipHitZone(8, MIN_PRECISION_CLIP_WIDTH)).toBe('body');
  });
});

describe('showsTrimHandles', () => {
  it('hides the visual handles on narrow clips', () => {
    expect(showsTrimHandles(4)).toBe(false);
    expect(showsTrimHandles(MIN_PRECISION_CLIP_WIDTH - 1)).toBe(false);
  });

  it('shows them from the minimum width up', () => {
    expect(showsTrimHandles(MIN_PRECISION_CLIP_WIDTH)).toBe(true);
    expect(showsTrimHandles(400)).toBe(true);
  });
});
