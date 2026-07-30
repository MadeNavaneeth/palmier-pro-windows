/**
 * ShortcutHelpDialog — the discoverable half of upstream issue #164.
 *
 * Parity with another NLE's key layout is worth little if the bindings are
 * invisible, so the sheet is generated from the same catalogue the handler
 * dispatches on. A command added to `shared/editor/shortcuts.ts` appears here
 * without touching this file, and one that is renamed cannot be listed wrongly.
 */

import React, { useCallback, useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import {
  formatShortcut,
  primaryShortcutLabel,
  shortcutsByCategory,
} from '../../shared/editor/shortcuts';

const GROUPS = shortcutsByCategory();

interface ShortcutHelpDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ShortcutHelpDialog({ isOpen, onClose }: ShortcutHelpDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  // Move focus in on open and put it back on close, so opening the sheet from
  // the keyboard does not strand the focus ring behind the overlay.
  useEffect(() => {
    if (!isOpen) return;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    closeButtonRef.current?.focus();
    return () => restoreFocusRef.current?.focus();
  }, [isOpen]);

  // Keep Tab inside the dialog. Escape is handled by the global shortcut layer,
  // which owns dismissal for every overlay.
  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key !== 'Tab') return;
    const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (!focusable || focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      // Clicking the backdrop dismisses; a press that started inside the panel
      // and ended on the backdrop (text drag) must not.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcut-help-title"
        onKeyDown={handleKeyDown}
        className="flex max-h-full w-[min(900px,100%)] flex-col overflow-hidden rounded-lg border border-surface-3 bg-surface-1 shadow-2xl"
      >
        <header className="flex shrink-0 items-center justify-between border-b border-white/10 px-5 py-3.5">
          <div>
            <h2 id="shortcut-help-title" className="text-sm font-medium text-text-primary">
              Keyboard Shortcuts
            </h2>
            <p className="mt-0.5 text-[10px] text-text-muted">
              Press {primaryShortcutLabel('showShortcuts')} to close
            </p>
          </div>
          <button
            ref={closeButtonRef}
            onClick={onClose}
            className="icon-button"
            aria-label="Close keyboard shortcuts"
          >
            <X size={14} />
          </button>
        </header>

        {/* Column count adapts so the sheet stays readable at 1024px wide and
            still fills a 1600px window without a single tall column. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="gap-x-8 [column-count:1] sm:[column-count:2] lg:[column-count:3]">
            {GROUPS.map((group) => (
              <section key={group.category} className="mb-5 break-inside-avoid">
                <h3 className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-text-muted">
                  {group.category}
                </h3>
                <dl className="space-y-0.5">
                  {group.items.map((item) => (
                    <div
                      key={item.id}
                      className="flex items-baseline justify-between gap-3 rounded px-1 py-1 hover:bg-white/[0.04]"
                    >
                      <dt className="min-w-0 text-xs text-text-secondary">{item.label}</dt>
                      <dd className="flex shrink-0 items-center gap-1">
                        {item.bindings.map((binding, index) => (
                          <React.Fragment key={formatShortcut(binding)}>
                            {index > 0 && <span className="text-[10px] text-text-muted">/</span>}
                            <Kbd>{formatShortcut(binding)}</Kbd>
                          </React.Fragment>
                        ))}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        </div>

        <footer className="shrink-0 border-t border-white/10 px-5 py-2.5 text-[10px] text-text-muted">
          Shortcuts are inactive while a text field has focus.
        </footer>
      </div>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-surface-4 bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] leading-none text-text-primary">
      {children}
    </kbd>
  );
}
