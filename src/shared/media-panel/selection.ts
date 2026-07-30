/**
 * Media browser selection model.
 *
 * Windows translation of upstream Palmier Pro PR #409 ("improve media browser
 * selection and actions"). Upstream keeps this on the editor view model; here it
 * is a pure state transition so the interaction rules are testable without a
 * rendered grid, and the panel store stays a thin wrapper.
 *
 * The rules preserved from upstream:
 *
 *   - Four selection modes driven by modifier keys, including shift+ctrl which
 *     unions a range onto the existing selection rather than replacing it.
 *   - Selection is always validated against the items currently VISIBLE. A
 *     filtered-out or deleted asset can never stay selected, which is the
 *     "prevent stale media browser selection" fix.
 *   - The anchor drives range selection and arrow navigation, and is re-derived
 *     whenever it falls out of the selection or out of view.
 *   - Arrow navigation walks the visible order; up/down step by the grid's
 *     column count, and search results navigate linearly because they render as
 *     a single column.
 */

export type MediaSelectionMode = 'replacing' | 'toggling' | 'range' | 'extendingRange';

export type MediaSelectionDirection = 'left' | 'right' | 'up' | 'down';

export interface MediaSelectionState {
  /** Selected asset ids. Always a subset of the visible ids. */
  selectedIds: readonly string[];
  /** Range/navigation anchor, or null when there is no selection. */
  anchorId: string | null;
  /** Item the view should scroll into view, consumed by the grid. */
  scrollTargetId: string | null;
}

export const EMPTY_MEDIA_SELECTION: MediaSelectionState = {
  selectedIds: [],
  anchorId: null,
  scrollTargetId: null,
};

/**
 * Map a pointer event's modifiers to a selection mode.
 *
 * Ctrl is the Windows toggle modifier where upstream uses Command; Meta is also
 * accepted so an Apple keyboard attached to a Windows machine behaves sensibly.
 */
export function selectionModeFromModifiers(modifiers: {
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}): MediaSelectionMode {
  const toggle = Boolean(modifiers.ctrlKey || modifiers.metaKey);
  const shift = Boolean(modifiers.shiftKey);
  if (toggle && shift) return 'extendingRange';
  if (toggle) return 'toggling';
  if (shift) return 'range';
  return 'replacing';
}

/** Steps through the visible order for one arrow press. */
function directionStep(direction: MediaSelectionDirection, columnCount: number): number {
  const columns = Math.max(1, Math.floor(columnCount) || 1);
  switch (direction) {
    case 'left':
      return -1;
    case 'right':
      return 1;
    case 'up':
      return -columns;
    case 'down':
      return columns;
  }
}

function startsFromEnd(direction: MediaSelectionDirection): boolean {
  return direction === 'left' || direction === 'up';
}

/**
 * Apply a click on `itemId` in the visible order.
 *
 * Returns the unchanged state when the id is not visible, so a click on a stale
 * tile can never resurrect it into the selection.
 */
export function applyMediaSelection(
  state: MediaSelectionState,
  itemId: string,
  mode: MediaSelectionMode,
  orderedIds: readonly string[],
): MediaSelectionState {
  if (!orderedIds.includes(itemId)) return state;

  const visible = new Set(orderedIds);
  const current = state.selectedIds.filter((id) => visible.has(id));

  switch (mode) {
    case 'replacing':
      return normalize({ selectedIds: [itemId], anchorId: itemId, scrollTargetId: null }, orderedIds);

    case 'toggling': {
      const next = current.includes(itemId)
        ? current.filter((id) => id !== itemId)
        : [...current, itemId];
      return normalize({ selectedIds: next, anchorId: itemId, scrollTargetId: null }, orderedIds);
    }

    case 'range':
    case 'extendingRange': {
      const range = rangeThrough(state.anchorId, itemId, orderedIds);
      if (!range) {
        // No usable anchor (first shift-click, or the anchor scrolled out of the
        // filtered view): behave like a plain click and seed a new anchor.
        return normalize(
          { selectedIds: [itemId], anchorId: itemId, scrollTargetId: null },
          orderedIds,
        );
      }
      const next = mode === 'range' ? range : [...new Set([...current, ...range])];
      // The anchor is deliberately kept so repeated shift-clicks grow or shrink
      // the same range instead of walking it.
      return normalize({ ...state, selectedIds: next, scrollTargetId: null }, orderedIds);
    }
  }
}

/** Inclusive slice of the visible order between the anchor and the target. */
function rangeThrough(
  anchorId: string | null,
  itemId: string,
  orderedIds: readonly string[],
): string[] | null {
  if (anchorId === null) return null;
  const anchorIndex = orderedIds.indexOf(anchorId);
  const targetIndex = orderedIds.indexOf(itemId);
  if (anchorIndex < 0 || targetIndex < 0) return null;
  const from = Math.min(anchorIndex, targetIndex);
  const to = Math.max(anchorIndex, targetIndex);
  return orderedIds.slice(from, to + 1);
}

/**
 * Move the selection one step in `direction`, replacing it.
 *
 * Navigation starts from the last selected item in visible order, matching
 * upstream. With nothing selected, a backwards direction starts at the end of
 * the grid and a forwards direction at the start. Steps are clamped to the
 * grid, so holding an arrow key parks at the edge instead of wrapping.
 */
export function moveMediaSelection(
  state: MediaSelectionState,
  direction: MediaSelectionDirection,
  orderedIds: readonly string[],
  columnCount: number,
): MediaSelectionState {
  if (orderedIds.length === 0) return state;

  const selected = new Set(state.selectedIds);
  let index = -1;
  for (let i = orderedIds.length - 1; i >= 0; i -= 1) {
    if (selected.has(orderedIds[i])) {
      index = i;
      break;
    }
  }

  if (index < 0) {
    const seed = startsFromEnd(direction) ? orderedIds[orderedIds.length - 1] : orderedIds[0];
    return { selectedIds: [seed], anchorId: seed, scrollTargetId: seed };
  }

  const target = Math.max(
    0,
    Math.min(orderedIds.length - 1, index + directionStep(direction, columnCount)),
  );
  if (target === index && state.selectedIds.length === 1) return state;

  const next = orderedIds[target];
  return { selectedIds: [next], anchorId: next, scrollTargetId: next };
}

export function selectAllMedia(orderedIds: readonly string[]): MediaSelectionState {
  return {
    selectedIds: [...orderedIds],
    anchorId: orderedIds[0] ?? null,
    scrollTargetId: null,
  };
}

export function clearMediaSelection(): MediaSelectionState {
  return EMPTY_MEDIA_SELECTION;
}

/**
 * Drop anything no longer visible and re-derive the anchor.
 *
 * Called whenever the visible set changes — a search query, an import, a
 * delete — so the panel never holds a selection the user cannot see.
 */
export function pruneMediaSelection(
  state: MediaSelectionState,
  orderedIds: readonly string[],
): MediaSelectionState {
  return normalize(state, orderedIds);
}

function normalize(
  state: MediaSelectionState,
  orderedIds: readonly string[],
): MediaSelectionState {
  const visible = new Set(orderedIds);
  const selectedIds = orderedIds.filter((id) => state.selectedIds.includes(id));
  const anchorId =
    state.anchorId !== null && visible.has(state.anchorId) && selectedIds.includes(state.anchorId)
      ? state.anchorId
      : selectedIds[0] ?? null;
  const scrollTargetId =
    state.scrollTargetId !== null && visible.has(state.scrollTargetId)
      ? state.scrollTargetId
      : null;

  if (
    anchorId === state.anchorId
    && scrollTargetId === state.scrollTargetId
    && sameOrder(selectedIds, state.selectedIds)
  ) {
    return state;
  }
  return { selectedIds, anchorId, scrollTargetId };
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
