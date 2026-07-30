/**
 * Regression coverage for media browser selection (upstream PR #409),
 * including its follow-up fixes: keep selection aligned with visible items,
 * linear navigation in search results, and no stale selection.
 */

import { describe, it, expect } from 'vitest';
import {
  EMPTY_MEDIA_SELECTION,
  applyMediaSelection,
  clearMediaSelection,
  moveMediaSelection,
  pruneMediaSelection,
  selectAllMedia,
  selectionModeFromModifiers,
  type MediaSelectionState,
} from './selection';

const grid = ['a', 'b', 'c', 'd', 'e', 'f'];

function state(selectedIds: string[], anchorId: string | null = null): MediaSelectionState {
  return { selectedIds, anchorId, scrollTargetId: null };
}

describe('selection mode from modifiers', () => {
  it('maps modifier combinations', () => {
    expect(selectionModeFromModifiers({})).toBe('replacing');
    expect(selectionModeFromModifiers({ ctrlKey: true })).toBe('toggling');
    expect(selectionModeFromModifiers({ metaKey: true })).toBe('toggling');
    expect(selectionModeFromModifiers({ shiftKey: true })).toBe('range');
    expect(selectionModeFromModifiers({ ctrlKey: true, shiftKey: true })).toBe('extendingRange');
  });
});

describe('click selection', () => {
  it('replaces the selection on a plain click', () => {
    const next = applyMediaSelection(state(['a', 'b'], 'a'), 'd', 'replacing', grid);
    expect(next.selectedIds).toEqual(['d']);
    expect(next.anchorId).toBe('d');
  });

  it('toggles a single item and keeps visible order', () => {
    let next = applyMediaSelection(state(['c'], 'c'), 'a', 'toggling', grid);
    expect(next.selectedIds).toEqual(['a', 'c']);
    expect(next.anchorId).toBe('a');

    next = applyMediaSelection(next, 'c', 'toggling', grid);
    expect(next.selectedIds).toEqual(['a']);
  });

  it('re-anchors when toggling removes the anchor', () => {
    const next = applyMediaSelection(state(['a', 'b'], 'a'), 'a', 'toggling', grid);
    expect(next.selectedIds).toEqual(['b']);
    expect(next.anchorId).toBe('b');
  });

  it('selects a range from the anchor in either direction', () => {
    expect(applyMediaSelection(state(['b'], 'b'), 'e', 'range', grid).selectedIds).toEqual([
      'b', 'c', 'd', 'e',
    ]);
    expect(applyMediaSelection(state(['e'], 'e'), 'b', 'range', grid).selectedIds).toEqual([
      'b', 'c', 'd', 'e',
    ]);
  });

  it('keeps the anchor so a second shift-click reshapes the same range', () => {
    const first = applyMediaSelection(state(['b'], 'b'), 'e', 'range', grid);
    const second = applyMediaSelection(first, 'c', 'range', grid);
    expect(second.selectedIds).toEqual(['b', 'c']);
    expect(second.anchorId).toBe('b');
  });

  it('unions a range onto the selection when extending', () => {
    const next = applyMediaSelection(state(['a', 'b'], 'b'), 'd', 'extendingRange', grid);
    expect(next.selectedIds).toEqual(['a', 'b', 'c', 'd']);
  });

  it('falls back to a plain click when there is no usable anchor', () => {
    expect(applyMediaSelection(EMPTY_MEDIA_SELECTION, 'c', 'range', grid).selectedIds).toEqual(['c']);
    // Anchor no longer visible (filtered out).
    const stale = state(['c'], 'zz');
    expect(applyMediaSelection(stale, 'd', 'range', grid).selectedIds).toEqual(['d']);
  });

  it('ignores a click on an item that is not visible', () => {
    const current = state(['a'], 'a');
    expect(applyMediaSelection(current, 'missing', 'replacing', grid)).toBe(current);
  });

  it('drops ids that left the visible set while selecting', () => {
    const next = applyMediaSelection(state(['a', 'gone'], 'a'), 'b', 'toggling', grid);
    expect(next.selectedIds).toEqual(['a', 'b']);
  });
});

describe('keyboard navigation', () => {
  it('steps one item horizontally and by a row vertically', () => {
    const columns = 3;
    expect(moveMediaSelection(state(['a'], 'a'), 'right', grid, columns).selectedIds).toEqual(['b']);
    expect(moveMediaSelection(state(['b'], 'b'), 'left', grid, columns).selectedIds).toEqual(['a']);
    expect(moveMediaSelection(state(['a'], 'a'), 'down', grid, columns).selectedIds).toEqual(['d']);
    expect(moveMediaSelection(state(['d'], 'd'), 'up', grid, columns).selectedIds).toEqual(['a']);
  });

  it('navigates linearly when the view is a single column, as search results are', () => {
    expect(moveMediaSelection(state(['a'], 'a'), 'down', grid, 1).selectedIds).toEqual(['b']);
    expect(moveMediaSelection(state(['b'], 'b'), 'up', grid, 1).selectedIds).toEqual(['a']);
  });

  it('treats a missing column count as one column instead of collapsing', () => {
    expect(moveMediaSelection(state(['a'], 'a'), 'down', grid, 0).selectedIds).toEqual(['b']);
  });

  it('clamps at the grid edges instead of wrapping', () => {
    expect(moveMediaSelection(state(['a'], 'a'), 'up', grid, 3).selectedIds).toEqual(['a']);
    expect(moveMediaSelection(state(['f'], 'f'), 'down', grid, 3).selectedIds).toEqual(['f']);
    expect(moveMediaSelection(state(['e'], 'e'), 'down', grid, 3).selectedIds).toEqual(['f']);
  });

  it('starts from the correct end when nothing is selected', () => {
    expect(moveMediaSelection(EMPTY_MEDIA_SELECTION, 'right', grid, 3).selectedIds).toEqual(['a']);
    expect(moveMediaSelection(EMPTY_MEDIA_SELECTION, 'left', grid, 3).selectedIds).toEqual(['f']);
    expect(moveMediaSelection(EMPTY_MEDIA_SELECTION, 'up', grid, 3).selectedIds).toEqual(['f']);
    expect(moveMediaSelection(EMPTY_MEDIA_SELECTION, 'down', grid, 3).selectedIds).toEqual(['a']);
  });

  it('collapses a multi-selection to the item after the last one selected', () => {
    const next = moveMediaSelection(state(['a', 'b', 'c'], 'a'), 'right', grid, 3);
    expect(next.selectedIds).toEqual(['d']);
    expect(next.anchorId).toBe('d');
  });

  it('requests a scroll to the newly selected item', () => {
    expect(moveMediaSelection(state(['a'], 'a'), 'right', grid, 3).scrollTargetId).toBe('b');
  });

  it('does nothing in an empty grid', () => {
    const current = state([]);
    expect(moveMediaSelection(current, 'down', [], 3)).toBe(current);
  });
});

describe('select all and clear', () => {
  it('selects every visible item and anchors at the first', () => {
    const next = selectAllMedia(grid);
    expect(next.selectedIds).toEqual(grid);
    expect(next.anchorId).toBe('a');
  });

  it('selects nothing in an empty view', () => {
    expect(selectAllMedia([])).toEqual({ selectedIds: [], anchorId: null, scrollTargetId: null });
  });

  it('clears to the empty selection', () => {
    expect(clearMediaSelection()).toEqual(EMPTY_MEDIA_SELECTION);
  });
});

describe('pruning against the visible set', () => {
  it('drops items that are filtered out and re-anchors', () => {
    const next = pruneMediaSelection(state(['a', 'c', 'e'], 'c'), ['c', 'e']);
    expect(next.selectedIds).toEqual(['c', 'e']);
    expect(next.anchorId).toBe('c');
  });

  it('re-anchors when the anchor itself is filtered out', () => {
    const next = pruneMediaSelection(state(['a', 'c'], 'a'), ['c', 'd']);
    expect(next.selectedIds).toEqual(['c']);
    expect(next.anchorId).toBe('c');
  });

  it('clears the anchor and scroll target when nothing remains visible', () => {
    const next = pruneMediaSelection(
      { selectedIds: ['a'], anchorId: 'a', scrollTargetId: 'a' },
      ['c', 'd'],
    );
    expect(next).toEqual({ selectedIds: [], anchorId: null, scrollTargetId: null });
  });

  it('reorders the selection to match the visible order', () => {
    const next = pruneMediaSelection(state(['e', 'b'], 'b'), grid);
    expect(next.selectedIds).toEqual(['b', 'e']);
  });

  it('returns the same object when nothing changes, so stores do not churn', () => {
    const current = state(['b', 'e'], 'b');
    expect(pruneMediaSelection(current, grid)).toBe(current);
  });
});
