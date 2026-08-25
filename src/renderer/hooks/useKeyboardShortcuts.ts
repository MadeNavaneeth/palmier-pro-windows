/**
 * useKeyboardShortcuts — global keyboard handler for the timeline editor.
 *
 * The chords themselves live in `shared/editor/shortcuts.ts`. This hook only
 * maps a matched command id to an action, which keeps the help panel and the
 * handler from drifting apart: an id with no case here is a TypeScript error,
 * not a key that silently does nothing.
 *
 * Upstream issue #164 (Premiere / DaVinci Resolve keyboard parity).
 */

import { useEffect, useCallback } from 'react';
import { useTimelineStore } from '../store/timeline';
import { useProjectStore } from '../store/project';
import { useUiStore } from '../store/ui';
import { shuttleForward, shuttleReverse } from '../../shared/editor/playback-rate';
import { matchShortcut, type ShortcutId } from '../../shared/editor/shortcuts';

/**
 * Commands that stay live while a modal is open.
 *
 * Everything else belongs to the dialog. Escape has to keep working or a modal
 * could trap the keyboard, and the shortcut sheet stays toggleable so it can be
 * dismissed the same way it was opened.
 */
const MODAL_SAFE_SHORTCUTS: ReadonlySet<ShortcutId> = new Set<ShortcutId>([
  'deselectAll',
  'showShortcuts',
]);

/**
 * True when the focused element should consume this key itself.
 *
 * Text entry claims every key — otherwise `c` would razor the timeline while
 * renaming a clip. A focused button claims only its activation keys, so Space
 * still presses the button (which keyboard-only navigation depends on) while
 * J/K/L and the rest keep working after a toolbar click leaves focus behind.
 */
function targetConsumesKey(target: EventTarget | null, key: string): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;

  switch (target.tagName) {
    case 'INPUT':
    case 'TEXTAREA':
    case 'SELECT':
      return true;
    case 'BUTTON':
    case 'A':
      return key === ' ' || key === 'Enter';
    default:
      return false;
  }
}

export function useKeyboardShortcuts() {
  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if (targetConsumesKey(event.target, event.key)) return;

    const shortcut = matchShortcut(event);
    if (!shortcut) return;

    // Read state at dispatch time. Subscribing to each action instead would
    // rebuild this listener on every store change during playback.
    const timeline = useTimelineStore.getState();
    const project = useProjectStore.getState();
    const ui = useUiStore.getState();

    // The export surface is a workspace panel (#166), not a modal: shortcuts
    // stay live while it is open, which is the point of being able to adjust
    // settings between renders. Only the shortcut sheet blocks.
    const modalOpen = ui.shortcutHelpOpen;
    if (modalOpen && !MODAL_SAFE_SHORTCUTS.has(shortcut.id)) return;

    event.preventDefault();

    switch (shortcut.id) {
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
      case 'deleteSelected':
        // Markers delete before clips (upstream PR #542): a selected marker
        // under Delete must not also be the frame where a clip vanishes.
        if (!timeline.deleteSelectedMarkers()) {
          timeline.removeSelectedClips();
        }
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
        // Escape dismisses the frontmost overlay before touching selection.
        if (ui.shortcutHelpOpen) ui.closeShortcutHelp();
        else if (ui.panels.export) ui.togglePanel('export');
        else {
          timeline.clearMarkerSelection();
          timeline.deselectAll();
        }
        return;

      // ── View ───────────────────────────────────────────────────────────────
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
        // The two safe areas are one delivery-spec concern, so one key drives
        // both rather than leaving a half-shown pair.
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

      // ── Project ────────────────────────────────────────────────────────────
      case 'newProject':
        if (confirmDiscardUnsavedWork(project.hasUnsavedChanges, 'start a new project')) {
          project.createNew();
        }
        return;
      case 'openProject':
        if (confirmDiscardUnsavedWork(project.hasUnsavedChanges, 'open another project')) {
          // Detached from the keypress; a rejection here must still be visible.
          void project.openExisting().catch((err: unknown) => {
            console.error('Open project failed:', err);
          });
        }
        return;
      case 'saveProject':
        void project.save().catch((err: unknown) => {
          // A failed save has to reach the user: they pressed Ctrl+S and would
          // otherwise carry on believing the work is on disk (#89).
          const message = err instanceof Error ? err.message : String(err);
          console.error('Save project failed:', err);
          window.alert(`Could not save the project.\n\n${message}`);
        });
        return;
      case 'exportProject':
        ui.togglePanel('export');
        return;

      default: {
        // Exhaustiveness guard: adding a command to the catalogue without
        // handling it here fails the build instead of shipping a dead key.
        const unhandled: never = shortcut.id;
        throw new Error(`Unhandled shortcut: ${String(unhandled)}`);
      }
    }
  }, []);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}

/**
 * Ask before an action that would drop unsaved edits.
 *
 * Ctrl+N and Ctrl+O sit one key away from Ctrl+M and Ctrl+S, and both replace
 * the whole project. A silently discarded edit is not recoverable through undo,
 * because the history is replaced along with the project.
 */
function confirmDiscardUnsavedWork(hasUnsavedChanges: boolean, action: string): boolean {
  if (!hasUnsavedChanges) return true;
  return window.confirm(`You have unsaved changes. Discard them and ${action}?`);
}
