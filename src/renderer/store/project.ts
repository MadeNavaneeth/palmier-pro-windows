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

  createNew: () => void;
  openExisting: () => Promise<void>;
  save: () => Promise<void>;
  setName: (name: string) => void;
  markDirty: () => void;
  markClean: () => void;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  name: 'Untitled Project',
  filePath: null,
  isLoaded: false,
  hasUnsavedChanges: false,

  createNew: () => {
    useTimelineStore.getState().controller.reset();
    set({ name: 'Untitled Project', filePath: null, isLoaded: true, hasUnsavedChanges: false });
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
}));
