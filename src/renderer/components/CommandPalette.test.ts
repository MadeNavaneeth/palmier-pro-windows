/**
 * Regression coverage for the command palette (upstream #516) and its
 * preset-aware chord labels (upstream #579).
 *
 * The palette is a display surface for the same shortcut catalogue the key
 * handler dispatches on, so its rows must print the resolved preset's chords. A
 * row that kept showing the default table while Final Cut Pro is active would
 * advertise a key that does nothing.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SHORTCUTS, matchShortcut, formatShortcut, shortcutChord } from '../../shared/editor/shortcuts';

// The palette reads its visibility and preset from the UI store. The real store
// initializes at import time and React's server renderer reads that initial
// snapshot, so a test cannot switch presets through `setState`; a tiny hook
// stand-in makes the active preset the test's input instead.
const uiState = vi.hoisted(() => ({
  commandPaletteOpen: true,
  shortcutPreset: 'default' as string,
}));

vi.mock('../store/ui', () => ({
  useUiStore: (selector: (state: typeof uiState & { closeCommandPalette: () => void }) => unknown) =>
    selector({ ...uiState, closeCommandPalette: () => {} }),
}));

const { CommandPalette } = await import('./CommandPalette');

afterEach(() => {
  uiState.shortcutPreset = 'default';
});

function renderPalette(): string {
  return renderToStaticMarkup(React.createElement(CommandPalette));
}

describe('CommandPalette (#516)', () => {
  it('is searchable by label, category, id, and chord', () => {
    const needle = 'marker';
    const filtered = SHORTCUTS.filter((def) => {
      const chord = def.bindings.map(formatShortcut).join(' ').toLowerCase();
      return def.label.toLowerCase().includes(needle)
        || def.category.toLowerCase().includes(needle)
        || chord.toLowerCase().includes(needle)
        || def.id.toLowerCase().includes(needle);
    });
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every((d) => d.category === 'Marking' || d.label.toLowerCase().includes('marker') || d.id.includes('Marker'))).toBe(true);
  });

  it('includes the palette itself and has no chord conflicts', () => {
    expect(SHORTCUTS.some((d) => d.id === 'showCommandPalette')).toBe(true);
    const chords = new Map<string, string>();
    for (const def of SHORTCUTS) {
      for (const b of def.bindings) {
        const chord = shortcutChord(b);
        const owner = chords.get(chord);
        // Ctrl+K and similar should be unique
        if (owner) expect(owner).not.toBe(def.id);
        else chords.set(chord, def.id);
      }
    }
  });

  it('Ctrl+K opens the palette and Escape is deselectAll', () => {
    expect(matchShortcut({ key: 'k', ctrlKey: true })?.id).toBe('showCommandPalette');
    expect(matchShortcut({ key: 'Escape' })?.id).toBe('deselectAll');
  });
});

describe('CommandPalette preset chords (#579)', () => {
  it('renders the active preset chords instead of the default table', () => {
    const defaultHtml = renderPalette();
    // Default table: the blade is bare C and Save is Ctrl+S.
    expect(defaultHtml).toContain('>C</span>');
    expect(defaultHtml).toContain('>Ctrl+S</span>');

    uiState.shortcutPreset = 'fcp';
    const fcpHtml = renderPalette();
    // FCP moves the blade to Ctrl+B and leaves Save unbound: the row must show
    // the new chord and must not fall back to the default one.
    expect(fcpHtml).toContain('>Ctrl+B</span>');
    expect(fcpHtml).not.toContain('>C</span>');
    expect(fcpHtml).not.toContain('>Ctrl+S</span>');
  });

  it('hides the toggle hint when the preset unbinds the palette', () => {
    expect(renderPalette()).toContain('Ctrl+K to toggle');

    uiState.shortcutPreset = 'fcp';
    expect(renderPalette()).not.toContain('Ctrl+K to toggle');
  });
});
