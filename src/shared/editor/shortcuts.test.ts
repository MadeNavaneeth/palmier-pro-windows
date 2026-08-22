/**
 * Regression coverage for the keyboard shortcut catalogue (upstream issue #164).
 *
 * The point of these tests is that a shortcut regression is loud. Two commands
 * claiming one chord, or a binding that fires while an unrequested modifier is
 * held, are the failure modes that are invisible in review and obvious to a
 * user mid-edit.
 */

import { describe, it, expect } from 'vitest';
import {
  SHORTCUTS,
  formatShortcut,
  matchShortcut,
  matchesBinding,
  primaryShortcutLabel,
  shortcutChord,
  shortcutConflicts,
  shortcutsByCategory,
  type ShortcutId,
} from './shortcuts';

describe('catalogue integrity', () => {
  it('binds no chord to two different commands', () => {
    expect(shortcutConflicts()).toEqual([]);
  });

  it('gives every command a unique id, a label and at least one binding', () => {
    const ids = new Set<ShortcutId>();
    for (const definition of SHORTCUTS) {
      expect(ids.has(definition.id)).toBe(false);
      ids.add(definition.id);
      expect(definition.label.length).toBeGreaterThan(0);
      expect(definition.bindings.length).toBeGreaterThan(0);
    }
  });

  it('detects a conflict when one is introduced', () => {
    const conflicts = shortcutConflicts([
      { id: 'undo', label: 'Undo', category: 'Editing', bindings: [{ key: 'z', ctrl: true }] },
      { id: 'redo', label: 'Redo', category: 'Editing', bindings: [{ key: 'Z', ctrl: true }] },
    ]);
    expect(conflicts).toEqual([{ chord: 'ctrl+z', ids: ['undo', 'redo'] }]);
  });
});

describe('matchesBinding', () => {
  it('matches keys case-insensitively', () => {
    expect(matchesBinding({ key: 'c' }, { key: 'C' })).toBe(true);
    expect(matchesBinding({ key: 'C' }, { key: 'c' })).toBe(true);
  });

  it('rejects a bare binding when a modifier is held', () => {
    // Ctrl+C must stay available to copy rather than razoring the clip.
    expect(matchesBinding({ key: 'c' }, { key: 'c', ctrlKey: true })).toBe(false);
    expect(matchesBinding({ key: 'c' }, { key: 'c', altKey: true })).toBe(false);
    expect(matchesBinding({ key: 'c' }, { key: 'c', shiftKey: true })).toBe(false);
  });

  it('requires the modifiers a binding asks for', () => {
    expect(matchesBinding({ key: 'z', ctrl: true }, { key: 'z' })).toBe(false);
    expect(matchesBinding({ key: 'z', ctrl: true }, { key: 'z', ctrlKey: true })).toBe(true);
  });

  it('treats Meta as Ctrl so an attached Apple keyboard works', () => {
    expect(matchesBinding({ key: 's', ctrl: true }, { key: 's', metaKey: true })).toBe(true);
  });

  it('distinguishes shifted from unshifted chords', () => {
    expect(matchesBinding({ key: 'i' }, { key: 'i', shiftKey: true })).toBe(false);
    expect(matchesBinding({ key: 'i', shift: true }, { key: 'i', shiftKey: true })).toBe(true);
  });
});

describe('matchShortcut', () => {
  const cases: [string, Parameters<typeof matchShortcut>[0], ShortcutId][] = [
    ['space plays', { key: ' ' }, 'playPause'],
    ['C razors', { key: 'c' }, 'splitAtPlayhead'],
    ['Delete lifts', { key: 'Delete' }, 'deleteSelected'],
    ['Shift+Delete ripples', { key: 'Delete', shiftKey: true }, 'rippleDeleteSelected'],
    [
      'Ctrl+Shift+Delete extracts',
      { key: 'Delete', ctrlKey: true, shiftKey: true },
      'extractMarkedRange',
    ],
    ['Ctrl+Z undoes', { key: 'z', ctrlKey: true }, 'undo'],
    ['Ctrl+Shift+Z redoes', { key: 'z', ctrlKey: true, shiftKey: true }, 'redo'],
    ['Ctrl+Y redoes', { key: 'y', ctrlKey: true }, 'redo'],
    ['I marks in', { key: 'i' }, 'setInPoint'],
    ['Shift+I seeks in', { key: 'i', shiftKey: true }, 'goToInPoint'],
    ['O marks out', { key: 'o' }, 'setOutPoint'],
    ['Shift+O seeks out', { key: 'o', shiftKey: true }, 'goToOutPoint'],
    ['X marks the clip', { key: 'x' }, 'markSelectedClip'],
    ['Ctrl+Shift+X clears marks', { key: 'x', ctrlKey: true, shiftKey: true }, 'clearMarkedRange'],
    ['Up steps to the previous edit', { key: 'ArrowUp' }, 'previousEdit'],
    ['Down steps to the next edit', { key: 'ArrowDown' }, 'nextEdit'],
    ['Shift+Left steps ten frames', { key: 'ArrowLeft', shiftKey: true }, 'stepBackMany'],
    ['S toggles snapping', { key: 's' }, 'toggleSnap'],
    ['G toggles thirds', { key: 'g' }, 'toggleThirds'],
    ['Shift+G toggles safe areas', { key: 'g', shiftKey: true }, 'toggleSafeAreas'],
    ['Ctrl+S saves', { key: 's', ctrlKey: true }, 'saveProject'],
    ['Ctrl+O opens', { key: 'o', ctrlKey: true }, 'openProject'],
    ['Ctrl+N is a new project', { key: 'n', ctrlKey: true }, 'newProject'],
    ['Ctrl+M exports', { key: 'm', ctrlKey: true }, 'exportProject'],
    ['backslash fits the timeline', { key: '\\' }, 'fitToWindow'],
    ['Ctrl+0 fits the timeline', { key: '0', ctrlKey: true }, 'fitToWindow'],
    ['F1 opens help', { key: 'F1' }, 'showShortcuts'],
  ];

  for (const [name, event, expected] of cases) {
    it(name, () => {
      expect(matchShortcut(event)?.id).toBe(expected);
    });
  }

  it('returns undefined for an unbound chord', () => {
    expect(matchShortcut({ key: 'q', altKey: true })).toBeUndefined();
    expect(matchShortcut({ key: 'F9' })).toBeUndefined();
  });

  it('leaves browser-only chords alone', () => {
    // Find/print/close-tab/reload/new-tab stay with the browser. Ctrl+C/V/X
    // are now editor clipboard commands: the keyboard hook ignores events
    // originating in editable fields, so text fields keep native behavior.
    for (const key of ['f', 'p', 'w', 'r', 't']) {
      const hit = matchShortcut({ key, ctrlKey: true });
      expect(hit).toBeUndefined();
    }
    for (const [key, id] of [
      ['c', 'copySelected'],
      ['v', 'pasteAtPlayhead'],
      ['x', 'cutSelected'],
    ] as const) {
      const hit = matchShortcut({ key, ctrlKey: true });
      expect(hit?.id, `${key}`).toBe(id);
    }
  });
});

describe('formatShortcut', () => {
  it('spells out modifiers in a stable order', () => {
    expect(formatShortcut({ key: 'x', ctrl: true, shift: true })).toBe('Ctrl+Shift+X');
    expect(formatShortcut({ key: 'z', ctrl: true })).toBe('Ctrl+Z');
  });

  it('names keys that have no printable glyph', () => {
    expect(formatShortcut({ key: ' ' })).toBe('Space');
    expect(formatShortcut({ key: 'ArrowLeft' })).toBe('←');
    expect(formatShortcut({ key: 'Escape' })).toBe('Esc');
    expect(formatShortcut({ key: 'Delete' })).toBe('Del');
    expect(formatShortcut({ key: 'F1' })).toBe('F1');
  });

  it('labels every catalogue binding with something non-empty', () => {
    for (const definition of SHORTCUTS) {
      for (const binding of definition.bindings) {
        expect(formatShortcut(binding).length).toBeGreaterThan(0);
      }
    }
  });
});

describe('shortcutChord', () => {
  it('is order-independent for modifiers and case-insensitive for keys', () => {
    expect(shortcutChord({ key: 'X', shift: true, ctrl: true })).toBe('ctrl+shift+x');
    expect(shortcutChord({ key: 'x', ctrl: true, shift: true })).toBe('ctrl+shift+x');
  });
});

describe('help panel data', () => {
  it('groups every command under exactly one category', () => {
    const groups = shortcutsByCategory();
    const total = groups.reduce((sum, group) => sum + group.items.length, 0);
    expect(total).toBe(SHORTCUTS.length);
    expect(new Set(groups.map((group) => group.category)).size).toBe(groups.length);
  });

  it('exposes a primary label for tooltips', () => {
    expect(primaryShortcutLabel('saveProject')).toBe('Ctrl+S');
    expect(primaryShortcutLabel('splitAtPlayhead')).toBe('C');
    expect(primaryShortcutLabel('playPause')).toBe('Space');
  });
});
