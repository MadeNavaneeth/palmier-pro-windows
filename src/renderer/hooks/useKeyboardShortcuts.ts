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
import { dispatchShortcut } from '../lib/shortcut-dispatcher';
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
  'showCommandPalette',
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
    if (targetConsumesKey(event.target, event.key)) {
      const target = event.target as HTMLElement | null;
      const inPalette = target?.closest?.('[data-command-palette]') !== null;
      if (!inPalette) return;
      if (event.key !== 'Escape') return;
    }

    const shortcut = matchShortcut(event);
    if (!shortcut) return;

    const { useUiStore } = require('../store/ui');
    const ui = useUiStore.getState() as ReturnType<typeof useUiStore.getState>;

    // The export surface is a workspace panel (#166), not a modal: shortcuts
    // stay live while it is open, which is the point of being able to adjust
    // settings between renders. Only the shortcut sheet blocks.
    const modalOpen = ui.shortcutHelpOpen || ui.commandPaletteOpen;
    if (modalOpen && !MODAL_SAFE_SHORTCUTS.has(shortcut.id)) return;

    event.preventDefault();
    dispatchShortcut(shortcut.id);
  }, []);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}
