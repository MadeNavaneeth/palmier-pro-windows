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
import { formatImportErrors } from '../../shared/media/import-summary';
import type { Clip } from '../../shared/types/project';
import { useTimelineStore } from './timeline';
import { useProjectStore } from './project';
import type { MediaProbeResult } from '../../main/ipc/media';

export interface MediaPanelState {
  selection: MediaSelectionState;
  /** Visible asset ids in render order. Published by the grid. */
  orderedIds: readonly string[];
  /** Columns the grid currently renders; 1 for list-style results. */
  columnCount: number;
  /** One-line status for panel actions (extraction failures, etc.). */
  notice: string | null;
  /**
   * The armed media swap (upstream PR #500): the clip waiting for a
   * replacement pick in the media grid. The fingerprint pins the clip's edit
   * state at arm time; if the timeline changes the clip underneath, the arm
   * is stale and completes as a cancellation rather than a swap.
   */
  armedSwap: { clipId: string; fingerprint: string } | null;
  /**
   * Whether audio clips shade their detected dead-air spans (#426's "Mark
   * Silence"). Session-scoped view state; the spans are advisory until one is
   * clicked, so it does not need to survive a restart to be useful.
   */
  showSilenceSpans: boolean;

  isSelected: (assetId: string) => boolean;
  publishVisibleItems: (orderedIds: readonly string[], columnCount: number) => void;
  selectItem: (assetId: string, mode: MediaSelectionMode) => void;
  moveSelection: (direction: MediaSelectionDirection) => void;
  selectAll: () => void;
  clearSelection: () => void;
  consumeScrollTarget: () => void;
  setNotice: (notice: string | null) => void;
  /** Arm (or toggle off) the pick-a-replacement flow for `clipId`. */
  armMediaSwap: (clipId: string) => void;
  /** Disarm without swapping (Escape, second tap on the same menu item). */
  cancelMediaSwap: () => void;
  /** Show or hide the shaded dead-air spans on audio clips (#426). */
  toggleSilenceSpans: (show: boolean) => void;
  /**
   * Finish the armed swap with `assetId`. A refused replacement keeps the
   * arm so another tile can be picked; an edit that moved the clip under
   * the arm cancels it instead of swapping.
   */
  completeArmedSwap: (assetId: string) => { swapped: boolean };
  /** Delete the selection (or `targetId` when it sits outside the selection). */
  deleteSelection: (targetId?: string) => { removedAssetIds: string[]; removedClipIds: string[] } | null;
  /**
   * Extract audio from the selection's video assets into standalone library
   * assets (upstream PR #562). Targets `targetId` when it sits outside the
   * selection, matching `deleteSelection`.
   */
  extractAudioSelection: (
    targetId?: string,
  ) => Promise<{ imported: number; errors: string[] }>;
}

/** Identity of the clip's edit state at arm time. */
function swapFingerprint(clip: Clip): string {
  return [clip.trackId, clip.startFrame, clip.durationFrames, clip.assetId].join(':');
}

/** A video asset is an extraction candidate only when it carries audio. */
export function canExtractAudio(asset: {
  type: string;
  audioCodec?: string;
}): boolean {
  return asset.type === 'video' && Boolean(asset.audioCodec);
}

export const useMediaPanelStore = create<MediaPanelState>((set, get) => ({
  selection: EMPTY_MEDIA_SELECTION,
  orderedIds: [],
  columnCount: 1,
  notice: null,
  armedSwap: null,
  showSilenceSpans: false,

  toggleSilenceSpans: (show) => set({ showSilenceSpans: show }),

  armMediaSwap: (clipId) => {
    set((state) => {
      // Tapping the same clip's menu item again disarms it.
      if (state.armedSwap?.clipId === clipId) return { armedSwap: null };
      const clip = useTimelineStore
        .getState()
        .controller.getClips()
        .find((candidate) => candidate.id === clipId);
      if (!clip) return { armedSwap: null };
      return { armedSwap: { clipId, fingerprint: swapFingerprint(clip) } };
    });
  },

  cancelMediaSwap: () => set({ armedSwap: null }),

  completeArmedSwap: (assetId) => {
    const armed = get().armedSwap;
    if (!armed) return { swapped: false };
    const timeline = useTimelineStore.getState();
    // Read through the controller: it owns the only current project, so an
    // edit that has not been mirrored into the store yet is still caught.
    const clip = timeline.controller
      .getClips()
      .find((candidate) => candidate.id === armed.clipId);

    // The timeline moved under the arm (moved, trimmed, split, deleted):
    // upstream cancels the armed swap rather than swapping a stale target.
    if (!clip || swapFingerprint(clip) !== armed.fingerprint) {
      set({ armedSwap: null, notice: 'Media swap cancelled — the clip changed on the timeline.' });
      return { swapped: false };
    }

    try {
      const receipt = timeline.controller.swapClipMedia(armed.clipId, assetId);
      useProjectStore.getState().markDirty();
      set({ armedSwap: null });
      return { swapped: receipt.changedClipIds.length > 0 };
    } catch (err: unknown) {
      // A refused replacement keeps the arm so another tile can be picked;
      // the domain refusal text is the reason the tile is dimmed.
      set({ notice: err instanceof Error ? err.message : String(err) });
      return { swapped: false };
    }
  },

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

  setNotice: (notice) => set({ notice }),

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

  extractAudioSelection: async (targetId) => {
    const { selection, orderedIds } = get();
    const ids =
      targetId !== undefined && !selection.selectedIds.includes(targetId)
        ? [targetId]
        : selection.selectedIds.filter((id) => orderedIds.includes(id));

    const timeline = useTimelineStore.getState();
    const candidates = ids
      .map((id) => timeline.project.media.find((asset) => asset.id === id))
      .filter((asset): asset is NonNullable<typeof asset> => Boolean(asset))
      .filter(canExtractAudio);

    const errors: string[] = [];
    const extracted: MediaProbeResult[] = [];
    for (const asset of candidates) {
      try {
        const result = await window.palmier.media.extractAudio(asset.path);
        if (result.success) {
          extracted.push(result.asset);
        } else {
          errors.push(result.error);
        }
      } catch {
        errors.push(`Could not extract audio from ${asset.filename}`);
      }
    }

    if (extracted.length > 0) {
      timeline.importAssets(extracted);
      useProjectStore.getState().markDirty();
    }
    set({
      notice: errors.length > 0
        ? formatImportErrors(errors)
        : extracted.length > 0
          ? null
          : 'No selected video has extractable audio',
    });
    return { imported: extracted.length, errors };
  },
}));
