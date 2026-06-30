/**
 * TitleBar — custom frameless title bar with drag region,
 * project name, edit menu (undo/redo), and quick actions.
 */

import React, { useState, useRef, useEffect } from 'react';
import { useProjectStore } from '../store/project';
import { useTimelineStore } from '../store/timeline';

export function TitleBar() {
  const { name, hasUnsavedChanges, save } = useProjectStore();
  const canUndo = useTimelineStore((s) => s.canUndo());
  const canRedo = useTimelineStore((s) => s.canRedo());
  const undo = useTimelineStore((s) => s.undo);
  const redo = useTimelineStore((s) => s.redo);

  return (
    <header className="drag-region flex h-9 items-center justify-between border-b border-surface-3 bg-surface-1 px-4">
      {/* Left: App name + menus */}
      <div className="flex items-center gap-3">
        <span className="text-2xs font-semibold uppercase tracking-wider text-accent">
          Palmier Pro
        </span>

        {/* Edit menu */}
        <div className="no-drag flex items-center gap-0.5">
          <EditMenu canUndo={canUndo} canRedo={canRedo} onUndo={undo} onRedo={redo} />
        </div>

        {/* Project name */}
        <span className="text-xs text-text-secondary">
          {name}
          {hasUnsavedChanges && <span className="ml-1 text-text-muted">*</span>}
        </span>
      </div>

      {/* Center: Undo/Redo quick buttons */}
      <div className="no-drag flex items-center gap-1">
        <button
          onClick={undo}
          disabled={!canUndo}
          className={`rounded px-1.5 py-0.5 text-xs transition ${
            canUndo ? 'text-text-secondary hover:bg-surface-3 hover:text-text-primary' : 'text-text-muted/30 cursor-not-allowed'
          }`}
          title="Undo (Ctrl+Z)"
        >
          ↩
        </button>
        <button
          onClick={redo}
          disabled={!canRedo}
          className={`rounded px-1.5 py-0.5 text-xs transition ${
            canRedo ? 'text-text-secondary hover:bg-surface-3 hover:text-text-primary' : 'text-text-muted/30 cursor-not-allowed'
          }`}
          title="Redo (Ctrl+Y)"
        >
          ↪
        </button>
      </div>

      {/* Right: Save */}
      <div className="no-drag flex items-center gap-2">
        <button
          onClick={() => save()}
          className="rounded px-2 py-0.5 text-xs text-text-secondary transition hover:bg-surface-3 hover:text-text-primary"
          title="Save project (Ctrl+S)"
        >
          Save
        </button>
      </div>
    </header>
  );
}

// ─── Edit Menu Dropdown ──────────────────────────────────────────────────────

function EditMenu({
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: {
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const splitAtPlayhead = useTimelineStore((s) => s.splitAtPlayhead);
  const removeSelectedClips = useTimelineStore((s) => s.removeSelectedClips);
  const rippleDelete = useTimelineStore((s) => s.rippleDelete);
  const selectedClipIds = useTimelineStore((s) => s.selectedClipIds);
  const hasSelection = selectedClipIds.size > 0;

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  return (
    <div ref={menuRef} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={`rounded px-2 py-0.5 text-xs transition ${
          open ? 'bg-surface-3 text-text-primary' : 'text-text-secondary hover:bg-surface-3 hover:text-text-primary'
        }`}
      >
        Edit
      </button>

      {open && (
        <div className="absolute top-full left-0 z-50 mt-1 w-52 rounded-md border border-surface-3 bg-surface-2 py-1 shadow-xl animate-fade-in">
          <MenuItem
            label="Undo"
            shortcut="Ctrl+Z"
            disabled={!canUndo}
            onClick={() => { onUndo(); setOpen(false); }}
          />
          <MenuItem
            label="Redo"
            shortcut="Ctrl+Y"
            disabled={!canRedo}
            onClick={() => { onRedo(); setOpen(false); }}
          />
          <MenuDivider />
          <MenuItem
            label="Split at Playhead"
            shortcut="C"
            onClick={() => { splitAtPlayhead(); setOpen(false); }}
          />
          <MenuItem
            label="Delete"
            shortcut="Del"
            disabled={!hasSelection}
            onClick={() => { removeSelectedClips(); setOpen(false); }}
          />
          <MenuItem
            label="Ripple Delete"
            shortcut="Shift+Del"
            disabled={!hasSelection}
            onClick={() => { rippleDelete(); setOpen(false); }}
          />
          <MenuDivider />
          <MenuItem
            label="Select All"
            shortcut="Ctrl+A"
            onClick={() => {
              const clips = useTimelineStore.getState().getClips();
              useTimelineStore.setState({ selectedClipIds: new Set(clips.map((c) => c.id)) });
              setOpen(false);
            }}
          />
          <MenuItem
            label="Deselect All"
            shortcut="Esc"
            onClick={() => {
              useTimelineStore.getState().deselectAll();
              setOpen(false);
            }}
          />
        </div>
      )}
    </div>
  );
}

function MenuItem({
  label,
  shortcut,
  disabled = false,
  onClick,
}: {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex w-full items-center justify-between px-3 py-1.5 text-xs transition ${
        disabled
          ? 'text-text-muted/40 cursor-not-allowed'
          : 'text-text-primary hover:bg-surface-3'
      }`}
    >
      <span>{label}</span>
      {shortcut && (
        <span className="text-2xs text-text-muted">{shortcut}</span>
      )}
    </button>
  );
}

function MenuDivider() {
  return <div className="mx-2 my-1 h-px bg-surface-3" />;
}
