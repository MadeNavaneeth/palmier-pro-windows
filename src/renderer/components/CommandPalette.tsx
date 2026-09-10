/**
 * CommandPalette — searchable inventory of every manual editing command.
 *
 * Upstream issue #516 asked for a clearer way to find the manual tools than
 * hunting the toolbar. The palette lists the same `SHORTCUTS` catalogue the
 * keyboard layer uses (so it cannot drift), filters by label/category/chord,
 * and invokes the shared `dispatchShortcut` so a palette row does exactly what
 * its chord does. Free, local, and zero-cost — the value is discoverability
 * without a new backend or paid service.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { SHORTCUTS, formatShortcut } from '../../shared/editor/shortcuts';
import { dispatchShortcut } from '../lib/shortcut-dispatcher';
import { useUiStore } from '../store/ui';

export function CommandPalette() {
  const open = useUiStore((s) => s.commandPaletteOpen);
  const close = useUiStore((s) => s.closeCommandPalette);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return SHORTCUTS;
    return SHORTCUTS.filter((def: (typeof SHORTCUTS)[number]) => {
      const chord = def.bindings.map(formatShortcut).join(' ').toLowerCase();
      return def.label.toLowerCase().includes(needle)
        || def.category.toLowerCase().includes(needle)
        || chord.toLowerCase().includes(needle)
        || def.id.toLowerCase().includes(needle);
    });
  }, [query]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelected(0);
    // Next frame so the input exists in the DOM.
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setSelected(0);
  }, [filtered.length]);

  // Keep selected row visible.
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  if (!open) return null;

  const run = (index: number) => {
    const def = filtered[index];
    if (!def) return;
    close();
    // Defer so the palette unmounts before the action mutates the timeline and
    // steals focus back from the closing animation.
    requestAnimationFrame(() => dispatchShortcut(def.id));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-[12vh]" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div
        data-command-palette
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="flex max-h-[60vh] w-[520px] flex-col overflow-hidden rounded-lg border border-surface-3 bg-surface-1 shadow-2xl"
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSelected((prev) => Math.min(prev + 1, filtered.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSelected((prev) => Math.max(prev - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            run(selected);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            close();
          }
        }}
      >
        <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
          <Search size={14} className="shrink-0 text-text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a command or shortcut…"
            className="min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted"
            aria-label="Search commands"
          />
          <span className="shrink-0 text-[10px] text-text-muted">Esc to close</span>
        </div>

        <div ref={listRef} className="flex-1 overflow-auto py-1">
          {filtered.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-text-muted">No commands match “{query}”.</p>
          ) : (
            filtered.map((def: (typeof SHORTCUTS)[number], index: number) => {
              const chord = def.bindings.map(formatShortcut).join('  ·  ');
              const active = index === selected;
              return (
                <button
                  key={def.id}
                  type="button"
                  data-index={index}
                  onMouseEnter={() => setSelected(index)}
                  onClick={() => run(index)}
                  className={`flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left transition ${active ? 'bg-accent/15 text-text-primary' : 'text-text-secondary hover:bg-white/[0.04] hover:text-text-primary'}`}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium">{def.label}</span>
                    <span className="block truncate text-[10px] text-text-muted">{def.category}</span>
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-text-muted">{chord}</span>
                </button>
              );
            })
          )}
        </div>

        <div className="border-t border-white/10 px-3 py-1.5 text-[10px] text-text-muted">
          ↑↓ to navigate · Enter to run · Esc to close · Ctrl+K to toggle
        </div>
      </div>
    </div>
  );
}
