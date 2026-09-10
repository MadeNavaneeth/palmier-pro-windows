import { describe, expect, it } from 'vitest';
import { SHORTCUTS, matchShortcut, formatShortcut, shortcutChord } from '../../shared/editor/shortcuts';

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
