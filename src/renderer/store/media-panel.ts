/**
 * Media panel view state: which assets are visible, which are selected, and the
 * grid geometry arrow keys navigate (upstream PR #409).
 *
 * The selection rules live in `shared/media-panel/selection.ts`; this store owns
 * only the live state and the bridge to the editor controller for deletion.
 */

import { create } from 'zustand';
import {
  EMPTY_MEDIA_SELECTION,
  applyMediaSelection,
  clearMediaSelection,
  moveMediaSelection,
  pruneMediaSelection,
  selectAllMedia,
  type MediaSelectionDirection,
  type MediaSelectionMode,
  type MediaSelectionState,
} from '../../shared/media-panel/selection';
import { useTimelineStore } from './timeline';
import { useProjectStore } from './project';

export interface MediaPanelState {
  selection: MediaSelectionState;
  /** Visible asset ids in render order. Published by the grid. */
  orderedIds: readonly string[];
  /** Columns the grid currently renders; 1 for list-style results. */
  columnCount: number;

  isSelected: (assetId: string) => boolean;
  publishVisibleItems: (orderedIds: readonly string[], columnCount: number) => void;
  selectItem: (assetId: string, mode: MediaSelectionMode) => void;
  moveSelection: (direction: MediaSelectionDirection) => void;
  selectAll: () => void;
  clearSelection: () => void;
  consumeScrollTarget: () => void;
  /** Delete the selection (or `targetId` when it sits outside the selection). */
  deleteSelection: (targetId?: string) => { removedAssetIds: string[]; removedClipIds: string[] } | null;
}

export const useMediaPanelStore = create<MediaPanelState>((set, get) => ({
  selection: EMPTY_MEDIA_SELECTION,
  orderedIds: [],
  columnCount: 1,

  isSelected: (assetId) => get().selection.selectedIds.includes(assetId),

  // Called whenever the filtered/sorted item list or the grid geometry changes.
  // Pruning here is what keeps a search or a delete from leaving a selection the
  // user cannot see.
  publishVisibleItems: (orderedIds, columnCount) => {
    set((state) => {
      const sameOrder =
        state.orderedIds.length === orderedIds.length
        && state.orderedIds.every((id, index) => id === orderedIds[index]);
      const nextColumns = Math.max(1, Math.floor(columnCount) || 1);
      if (sameOrder && state.columnCount === nextColumns) return state;
      return {
        orderedIds: sameOrder ? state.orderedIds : [...orderedIds],
        columnCount: nextColumns,
        selection: pruneMediaSelection(state.selection, orderedIds),
      };
    });
  },

  selectItem: (assetId, mode) => {
    set((state) => ({
      selection: applyMediaSelection(state.selection, assetId, mode, state.orderedIds),
    }));
  },

  moveSelection: (direction) => {
    set((state) => ({
      selection: moveMediaSelection(
        state.selection,
        direction,
        state.orderedIds,
        state.columnCount,
      ),
    }));
  },

  selectAll: () => set((state) => ({ selection: selectAllMedia(state.orderedIds) })),

  clearSelection: () => set({ selection: clearMediaSelection() }),

  consumeScrollTarget: () => {
    set((state) =>
      state.selection.scrollTargetId === null
        ? state
        : { selection: { ...state.selection, scrollTargetId: null } },
    );
  },

  deleteSelection: (targetId) => {
    const { selection, orderedIds } = get();
    // Right-clicking an unselected tile acts on that tile, matching upstream's
    // `deleteMediaPanelItems(targeting:)`.
    const ids =
      targetId !== undefined && !selection.selectedIds.includes(targetId)
        ? [targetId]
        : selection.selectedIds.filter((id) => orderedIds.includes(id));
    if (ids.length === 0) return null;

    const report = useTimelineStore.getState().removeMediaAssets(ids);
    if (!report) return null;

    set((state) => ({
      selection: pruneMediaSelection(
        state.selection,
        state.orderedIds.filter((id) => !report.removedAssetIds.includes(id)),
      ),
    }));
    useProjectStore.getState().markDirty();
    return report;
  },
}));
