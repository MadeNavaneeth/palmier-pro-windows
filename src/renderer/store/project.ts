/**
 * Project store — session metadata (name, file path, dirty/loaded state).
 *
 * The project DATA (media + timeline + settings) lives in the timeline
 * controller, which is the single source of truth. This store only tracks
 * the session shell and delegates save/open/new to that controller, so the
 * saved .vproj is always the complete, unified project.
 */

import { create } from 'zustand';
import { useTimelineStore } from './timeline';
import type { Project } from '../../shared/types/project';

interface ProjectState {
  name: string;
  filePath: string | null;
  isLoaded: boolean;
  hasUnsavedChanges: boolean;
  /**
   * A change from another editor this window refused to apply, or null.
   *
   * Set by `useEditorSync` when an inbound push is dropped because a local
   * write was still outstanding, so the record exists only for the window that
   * threw the push away.
   */
  droppedSync: DroppedSyncConflict | null;

  createNew: () => void;
  openExisting: () => Promise<void>;
  save: () => Promise<void>;
  setName: (name: string) => void;
  markDirty: () => void;
  markClean: () => void;
  /** Note a refused inbound push, counting it into the open conflict. */
  recordDroppedSync: (kind: DroppedSyncConflict['kind']) => void;
  /**
   * Retire the open conflict: the user dismissed the notice, this window took
   * another editor's state again, or the project was replaced.
   */
  clearDroppedSync: () => void;
}

/**
 * One refused inbound push, and what the notice has to be true about.
 *
 * Deliberately NOT the payload. A project snapshot is the largest thing the
 * renderer holds, the record outlives the debounce that caused the drop, and
 * keeping one would pin a whole project in memory to render a sentence — while
 * also handing a future reader a second copy of the state that is deliberately
 * not reconciled (see useEditor's dropped-push comment). Two fields are what
 * makes that sentence true:
 *
 *  - `kind` is MAIN's own verdict, forwarded rather than re-derived, and it is
 *    the whole difference between losing work and losing nothing: an `edit`
 *    published a command the user asked for, a `playhead` only moved a cursor.
 *  - `dropped` counts the rest of the turn, because main collapses a multi-tool
 *    turn into one push per 30ms window. A user who lost four edits has to be
 *    told four; a notice that says "a change" once is how a warning stops
 *    being believed.
 *
 * It deliberately does not name the agent tool call that produced the change.
 * Main's push metadata carries the kind and nothing else, so a tool identity
 * would mean widening that IPC contract — a main-process change well outside
 * this fix, and not needed to say what happened.
 */
export interface DroppedSyncConflict {
  kind: 'edit' | 'playhead';
  dropped: number;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  name: 'Untitled Project',
  filePath: null,
  isLoaded: false,
  hasUnsavedChanges: false,
  droppedSync: null,

  createNew: () => {
    useTimelineStore.getState().controller.reset();
    // A refusal recorded against the previous document says nothing about this
    // one, so it does not follow the user into it.
    set({
      name: 'Untitled Project',
      filePath: null,
      isLoaded: true,
      hasUnsavedChanges: false,
      droppedSync: null,
    });
  },

  openExisting: async () => {
    const result = await window.palmier.project.open();
    if (!result.success || !result.data) return;

    try {
      const project: Project = JSON.parse(result.data);
      // Load the full project (media + timeline) into the authoritative controller.
      useTimelineStore.getState().controller.loadProject(project);
      set({
        name: project.name || 'Untitled Project',
        filePath: result.path || null,
        isLoaded: true,
        hasUnsavedChanges: false,
        droppedSync: null,
      });
    } catch (err) {
      console.error('Failed to parse project file:', err);
    }
  },

  save: async () => {
    const { name, filePath } = get();
    const controller = useTimelineStore.getState().controller;

    // Serialize the unified project, stamping the session name onto it.
    const project = { ...controller.getProject(), name };
    const projectData = JSON.stringify(project, null, 2);

    const result = await window.palmier.project.save(projectData, filePath || undefined);
    if (!result.success) {
      // The project stays dirty. Reject so the caller can tell the user, rather
      // than returning normally and leaving a failed save looking like a clean
      // one (upstream #89).
      throw new Error(result.error || 'Could not write the project file.');
    }

    set({ filePath: result.path, hasUnsavedChanges: false });
    // A clean explicit save supersedes any crash-recovery snapshot (#211).
    // Detached: the save itself already succeeded, so a stale snapshot is a
    // nuisance rather than a failure, but it is worth knowing about.
    void window.palmier.project.recoveryClear().catch((err: unknown) => {
      console.warn('[project] Could not clear the crash-recovery snapshot:', err);
    });
  },

  setName: (name) => set({ name, hasUnsavedChanges: true }),
  markDirty: () => {
    if (!get().hasUnsavedChanges) set({ hasUnsavedChanges: true });
  },
  markClean: () => set({ hasUnsavedChanges: false }),

  recordDroppedSync: (kind) => {
    const open = get().droppedSync;
    // A dropped edit opens a conflict and its later drops extend it; a dropped
    // cursor move neither opens one nor inherits a count, because a lost
    // cursor position is not a conflict (useEditorSync stays silent for it).
    if (!open || (open.kind === 'playhead' && kind === 'edit')) {
      set({ droppedSync: { kind, dropped: 1 } });
      return;
    }
    set({ droppedSync: { kind: open.kind, dropped: open.dropped + 1 } });
  },
  clearDroppedSync: () => {
    if (get().droppedSync) set({ droppedSync: null });
  },
}));
