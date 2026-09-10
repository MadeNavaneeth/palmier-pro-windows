/**
 * Shared dispatcher for keyboard shortcuts and the command palette.
 *
 * Upstream issue #164 catalogued every editing command as data
 * (`shared/editor/shortcuts.ts`) so the help panel and the handler cannot
 * drift. The palette is a third consumer of that same list — it has to invoke
 * the same actions by id, otherwise Ctrl+K would offer a command that Ctrl+K
 * itself cannot run through the keyboard layer. Centralising the `id → action`
 * switch here makes an unhandled id a type error rather than a dead palette row.
 */

import { useProjectStore } from '../store/project';
import { useTimelineStore } from '../store/timeline';
import { useUiStore } from '../store/ui';
import { shuttleForward, shuttleReverse } from '../../shared/editor/playback-rate';
import type { ShortcutId } from '../../shared/editor/shortcuts';

export function dispatchShortcut(id: ShortcutId): void {
  const timeline = useTimelineStore.getState();
  const project = useProjectStore.getState();
  const ui = useUiStore.getState();

  switch (id) {
    // ── Playback ───────────────────────────────────────────────────────────
    case 'playPause':
      timeline.togglePlayback();
      return;
    case 'shuttleReverse':
      timeline.setPlaybackRate(shuttleReverse(timeline.playbackRate));
      if (!timeline.isPlaying) timeline.togglePlayback();
      return;
    case 'shuttlePause':
      if (timeline.isPlaying) timeline.togglePlayback();
      timeline.setPlaybackRate(1);
      return;
    case 'shuttleForward':
      timeline.setPlaybackRate(shuttleForward(timeline.playbackRate));
      if (!timeline.isPlaying) timeline.togglePlayback();
      return;
    case 'stepBack':
      timeline.stepFrame(-1);
      return;
    case 'stepForward':
      timeline.stepFrame(1);
      return;
    case 'stepBackMany':
      timeline.stepFrame(-10);
      return;
    case 'stepForwardMany':
      timeline.stepFrame(10);
      return;
    case 'previousEdit':
      timeline.goToPreviousEdit();
      return;
    case 'nextEdit':
      timeline.goToNextEdit();
      return;
    case 'goToStart':
      timeline.goToStart();
      return;
    case 'goToEnd':
      timeline.goToEnd();
      return;

    // ── Editing ────────────────────────────────────────────────────────────
    case 'splitAtPlayhead':
      timeline.splitAtPlayhead();
      return;
    case 'compactTake': {
      const selected = Array.from(timeline.selectedClipIds);
      if (selected.length > 0) timeline.compactTake(selected[0]);
      return;
    }
    case 'deleteSelected':
      if (!timeline.deleteSelectedMarkers()) timeline.removeSelectedClips();
      return;
    case 'copySelected':
      timeline.copySelectedClips();
      return;
    case 'cutSelected':
      timeline.cutSelectedClips();
      return;
    case 'pasteAtPlayhead':
      timeline.pasteClipsAtPlayhead();
      return;
    case 'duplicateSelected':
      timeline.duplicateSelected();
      return;
    case 'rippleDeleteSelected':
      timeline.rippleDelete();
      return;
    case 'extractMarkedRange':
      timeline.extractMarkedRange();
      return;
    case 'undo':
      timeline.undo();
      return;
    case 'redo':
      timeline.redo();
      return;

    // ── Marking ────────────────────────────────────────────────────────────
    case 'setInPoint':
      timeline.setInFrame();
      return;
    case 'setOutPoint':
      timeline.setOutFrame();
      return;
    case 'goToInPoint':
      timeline.goToInPoint();
      return;
    case 'goToOutPoint':
      timeline.goToOutPoint();
      return;
    case 'markSelectedClip':
      timeline.markSelectedClip();
      return;
    case 'clearMarkedRange':
      timeline.clearMarkedRange();
      return;
    case 'addMarker':
      timeline.addMarkerAtPlayhead();
      return;
    case 'nextMarker':
      timeline.goToNextMarker();
      return;
    case 'previousMarker':
      timeline.goToPreviousMarker();
      return;

    // ── Selection ──────────────────────────────────────────────────────────
    case 'selectAll':
      timeline.selectAllClips();
      return;
    case 'deselectAll':
      if (ui.commandPaletteOpen) {
        ui.closeCommandPalette();
        return;
      }
      if (ui.shortcutHelpOpen) {
        ui.closeShortcutHelp();
        return;
      }
      if (ui.panels.export) {
        ui.togglePanel('export');
        return;
      }
      timeline.clearMarkerSelection();
      timeline.deselectAll();
      return;

    // ── View ───────────────────────────────────────────────────────────────────
    case 'zoomIn':
      timeline.zoomIn();
      return;
    case 'zoomOut':
      timeline.zoomOut();
      return;
    case 'fitToWindow':
      timeline.fitToViewport();
      return;
    case 'toggleSnap':
      timeline.toggleSnap();
      return;
    case 'toggleThirds':
      ui.toggleGuide('thirds');
      return;
    case 'toggleSafeAreas':
      ui.setSafeAreaGuides(!(ui.guides.has('actionSafe') && ui.guides.has('titleSafe')));
      return;
    case 'layoutDefault':
      ui.setLayout('default');
      return;
    case 'layoutMedia':
      ui.setLayout('media');
      return;
    case 'layoutVertical':
      ui.setLayout('vertical');
      return;
    case 'showShortcuts':
      ui.toggleShortcutHelp();
      return;
    case 'showCommandPalette':
      ui.toggleCommandPalette();
      return;

    // ── Project ────────────────────────────────────────────────────────────
    case 'newProject':
      if (confirmDiscardUnsavedWork(project.hasUnsavedChanges, 'start a new project')) project.createNew();
      return;
    case 'openProject':
      if (confirmDiscardUnsavedWork(project.hasUnsavedChanges, 'open another project')) {
        void project.openExisting().catch((err: unknown) => console.error('Open project failed:', err));
      }
      return;
    case 'saveProject':
      void project.save().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error('Save project failed:', err);
        window.alert(`Could not save the project.\n\n${message}`);
      });
      return;
    case 'exportProject':
      ui.togglePanel('export');
      return;

    default: {
      const unhandled: never = id;
      throw new Error(`Unhandled shortcut: ${String(unhandled)}`);
    }
  }
}

function confirmDiscardUnsavedWork(hasUnsavedChanges: boolean, action: string): boolean {
  if (!hasUnsavedChanges) return true;
  return window.confirm(`You have unsaved changes. Discard them and ${action}?`);
}
