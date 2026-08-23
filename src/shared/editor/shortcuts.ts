/**
 * Keyboard shortcut catalogue.
 *
 * Upstream issue #164 asked for Premiere / DaVinci Resolve keyboard parity. The
 * chords live here as data rather than inside a handler switch for three
 * reasons: a conflict between two commands becomes a test failure instead of a
 * silent double-fire, the help panel and the handler cannot drift, and the set
 * can be reviewed against another NLE's layout without reading event code.
 *
 * Matching is strict about modifiers. A binding that does not ask for Ctrl must
 * not fire while Ctrl is held, otherwise Ctrl+C (copy) would also razor the
 * clip under the playhead. Shift is matched exactly too, which is what keeps
 * `I` (set in point) separate from `Shift+I` (go to in point).
 */

export type ShortcutCategory =
  | 'Playback'
  | 'Editing'
  | 'Marking'
  | 'Selection'
  | 'View'
  | 'Project';

export interface ShortcutBinding {
  /** `KeyboardEvent.key`, compared case-insensitively. */
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export interface ShortcutDefinition {
  id: ShortcutId;
  label: string;
  category: ShortcutCategory;
  bindings: readonly ShortcutBinding[];
}

export type ShortcutId =
  | 'playPause'
  | 'shuttleReverse'
  | 'shuttlePause'
  | 'shuttleForward'
  | 'stepBack'
  | 'stepBackMany'
  | 'stepForward'
  | 'stepForwardMany'
  | 'goToStart'
  | 'goToEnd'
  | 'previousEdit'
  | 'nextEdit'
  | 'splitAtPlayhead'
  | 'deleteSelected'
  | 'rippleDeleteSelected'
  | 'extractMarkedRange'
  | 'undo'
  | 'redo'
  | 'setInPoint'
  | 'setOutPoint'
  | 'goToInPoint'
  | 'goToOutPoint'
  | 'markSelectedClip'
  | 'clearMarkedRange'
  | 'addMarker'
  | 'nextMarker'
  | 'previousMarker'
  | 'copySelected'
  | 'cutSelected'
  | 'pasteAtPlayhead'
  | 'duplicateSelected'
  | 'selectAll'
  | 'deselectAll'
  | 'zoomIn'
  | 'zoomOut'
  | 'fitToWindow'
  | 'toggleSnap'
  | 'toggleThirds'
  | 'toggleSafeAreas'
  | 'layoutDefault'
  | 'layoutMedia'
  | 'layoutVertical'
  | 'newProject'
  | 'openProject'
  | 'saveProject'
  | 'exportProject'
  | 'showShortcuts';

export const SHORTCUTS: readonly ShortcutDefinition[] = [
  // ── Playback ───────────────────────────────────────────────────────────────
  { id: 'playPause', label: 'Play / pause', category: 'Playback', bindings: [{ key: ' ' }] },
  { id: 'shuttleReverse', label: 'Shuttle reverse (faster each press)', category: 'Playback', bindings: [{ key: 'j' }] },
  { id: 'shuttlePause', label: 'Pause and reset speed', category: 'Playback', bindings: [{ key: 'k' }] },
  { id: 'shuttleForward', label: 'Shuttle forward (faster each press)', category: 'Playback', bindings: [{ key: 'l' }] },
  { id: 'stepBack', label: 'Step back one frame', category: 'Playback', bindings: [{ key: 'ArrowLeft' }] },
  { id: 'stepForward', label: 'Step forward one frame', category: 'Playback', bindings: [{ key: 'ArrowRight' }] },
  { id: 'stepBackMany', label: 'Step back ten frames', category: 'Playback', bindings: [{ key: 'ArrowLeft', shift: true }] },
  { id: 'stepForwardMany', label: 'Step forward ten frames', category: 'Playback', bindings: [{ key: 'ArrowRight', shift: true }] },
  { id: 'previousEdit', label: 'Go to previous edit point', category: 'Playback', bindings: [{ key: 'ArrowUp' }] },
  { id: 'nextEdit', label: 'Go to next edit point', category: 'Playback', bindings: [{ key: 'ArrowDown' }] },
  { id: 'goToStart', label: 'Go to timeline start', category: 'Playback', bindings: [{ key: 'Home' }] },
  { id: 'goToEnd', label: 'Go to end of the last clip', category: 'Playback', bindings: [{ key: 'End' }] },

  // ── Editing ────────────────────────────────────────────────────────────────
  { id: 'splitAtPlayhead', label: 'Split clips at the playhead', category: 'Editing', bindings: [{ key: 'c' }] },
  {
    id: 'deleteSelected',
    label: 'Delete selected clips (leave a gap)',
    category: 'Editing',
    bindings: [{ key: 'Delete' }, { key: 'Backspace' }],
  },
  {
    id: 'rippleDeleteSelected',
    label: 'Ripple delete selected clips (close the gap)',
    category: 'Editing',
    bindings: [{ key: 'Delete', shift: true }, { key: 'Backspace', shift: true }],
  },
  {
    id: 'extractMarkedRange',
    label: 'Extract the marked range and close the gap',
    category: 'Editing',
    bindings: [{ key: 'Delete', ctrl: true, shift: true }, { key: 'Backspace', ctrl: true, shift: true }],
  },
  { id: 'undo', label: 'Undo', category: 'Editing', bindings: [{ key: 'z', ctrl: true }] },
  {
    id: 'cutSelected',
    label: 'Cut selected clips',
    category: 'Editing',
    bindings: [{ key: 'x', ctrl: true }],
  },
  {
    id: 'copySelected',
    label: 'Copy selected clips',
    category: 'Editing',
    bindings: [{ key: 'c', ctrl: true }],
  },
  { id: 'pasteAtPlayhead', label: 'Paste clips at the playhead', category: 'Editing', bindings: [{ key: 'v', ctrl: true }] },
  {
    id: 'duplicateSelected',
    label: 'Duplicate selected clips',
    category: 'Editing',
    bindings: [{ key: 'd', ctrl: true }],
  },  {
    id: 'redo',
    label: 'Redo',
    category: 'Editing',
    bindings: [{ key: 'y', ctrl: true }, { key: 'z', ctrl: true, shift: true }],
  },

  // ── Marking ────────────────────────────────────────────────────────────────
  { id: 'setInPoint', label: 'Set in point', category: 'Marking', bindings: [{ key: 'i' }] },
  { id: 'setOutPoint', label: 'Set out point', category: 'Marking', bindings: [{ key: 'o' }] },
  { id: 'goToInPoint', label: 'Go to in point', category: 'Marking', bindings: [{ key: 'i', shift: true }] },
  { id: 'goToOutPoint', label: 'Go to out point', category: 'Marking', bindings: [{ key: 'o', shift: true }] },
  { id: 'markSelectedClip', label: 'Mark the selected clip', category: 'Marking', bindings: [{ key: 'x' }] },
  { id: 'clearMarkedRange', label: 'Clear in and out points', category: 'Marking', bindings: [{ key: 'x', ctrl: true, shift: true }] },
  { id: 'addMarker', label: 'Add marker at the playhead', category: 'Marking', bindings: [{ key: 'm' }] },
  { id: 'nextMarker', label: 'Go to next marker', category: 'Marking', bindings: [{ key: 'ArrowRight', alt: true }] },
  { id: 'previousMarker', label: 'Go to previous marker', category: 'Marking', bindings: [{ key: 'ArrowLeft', alt: true }] },

  // ── Selection ──────────────────────────────────────────────────────────────
  { id: 'selectAll', label: 'Select all clips', category: 'Selection', bindings: [{ key: 'a', ctrl: true }] },
  { id: 'deselectAll', label: 'Deselect all', category: 'Selection', bindings: [{ key: 'Escape' }] },

  // ── View ───────────────────────────────────────────────────────────────────
  {
    id: 'zoomIn',
    label: 'Zoom in',
    category: 'View',
    // '+' is Shift+'=' on a US layout and unshifted on the numeric keypad.
    bindings: [{ key: '=' }, { key: '+', shift: true }, { key: '+' }],
  },
  { id: 'zoomOut', label: 'Zoom out', category: 'View', bindings: [{ key: '-' }] },
  {
    id: 'fitToWindow',
    label: 'Fit timeline to window',
    category: 'View',
    bindings: [{ key: '\\' }, { key: '0', ctrl: true }],
  },
  { id: 'toggleSnap', label: 'Toggle snapping', category: 'View', bindings: [{ key: 's' }] },
  {
    id: 'toggleThirds',
    label: 'Toggle rule-of-thirds guide',
    category: 'View',
    bindings: [{ key: 'g' }],
  },
  {
    id: 'toggleSafeAreas',
    label: 'Toggle title and action safe guides',
    category: 'View',
    bindings: [{ key: 'g', shift: true }],
  },
  // Workspace arrangements, on Ctrl plus a digit to match upstream's Cmd+1/2/3
  // (upstream PR #430).
  {
    id: 'layoutDefault',
    label: 'Default layout',
    category: 'View',
    bindings: [{ key: '1', ctrl: true }],
  },
  {
    id: 'layoutMedia',
    label: 'Media layout',
    category: 'View',
    bindings: [{ key: '2', ctrl: true }],
  },
  {
    id: 'layoutVertical',
    label: 'Vertical layout',
    category: 'View',
    bindings: [{ key: '3', ctrl: true }],
  },

  // ── Project ────────────────────────────────────────────────────────────────
  { id: 'newProject', label: 'New project', category: 'Project', bindings: [{ key: 'n', ctrl: true }] },
  { id: 'openProject', label: 'Open project', category: 'Project', bindings: [{ key: 'o', ctrl: true }] },
  { id: 'saveProject', label: 'Save project', category: 'Project', bindings: [{ key: 's', ctrl: true }] },
  { id: 'exportProject', label: 'Export video', category: 'Project', bindings: [{ key: 'm', ctrl: true }] },
  {
    id: 'showShortcuts',
    label: 'Show keyboard shortcuts',
    category: 'View',
    bindings: [{ key: '?', shift: true }, { key: '?' }, { key: 'F1' }],
  },
] as const;

/** The event fields shortcut matching needs, so callers can pass a plain object. */
export interface ShortcutEventLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

function normalizeKey(key: string): string {
  return typeof key === 'string' ? key.toLowerCase() : '';
}

/** Canonical chord string, used for conflict detection and as a map key. */
export function shortcutChord(binding: ShortcutBinding): string {
  const parts: string[] = [];
  if (binding.ctrl) parts.push('ctrl');
  if (binding.alt) parts.push('alt');
  if (binding.shift) parts.push('shift');
  parts.push(normalizeKey(binding.key));
  return parts.join('+');
}

/**
 * True when an event is exactly this chord.
 *
 * Ctrl and Meta are treated as one modifier so an attached Apple keyboard works;
 * every modifier the binding does not request must be absent.
 */
export function matchesBinding(binding: ShortcutBinding, event: ShortcutEventLike): boolean {
  if (normalizeKey(event.key) !== normalizeKey(binding.key)) return false;
  const ctrl = Boolean(event.ctrlKey || event.metaKey);
  return (
    ctrl === Boolean(binding.ctrl)
    && Boolean(event.shiftKey) === Boolean(binding.shift)
    && Boolean(event.altKey) === Boolean(binding.alt)
  );
}

/** The command an event triggers, or undefined when the chord is unbound. */
export function matchShortcut(
  event: ShortcutEventLike,
  shortcuts: readonly ShortcutDefinition[] = SHORTCUTS,
): ShortcutDefinition | undefined {
  return shortcuts.find((definition) =>
    definition.bindings.some((binding) => matchesBinding(binding, event)),
  );
}

/**
 * Chords claimed by more than one command.
 *
 * A conflict means one press would run two commands, and which one wins depends
 * on catalogue order — so this is asserted empty by the test suite rather than
 * left to review.
 */
export function shortcutConflicts(
  shortcuts: readonly ShortcutDefinition[] = SHORTCUTS,
): { chord: string; ids: ShortcutId[] }[] {
  const owners = new Map<string, ShortcutId[]>();
  for (const definition of shortcuts) {
    for (const binding of definition.bindings) {
      const chord = shortcutChord(binding);
      const existing = owners.get(chord);
      if (existing) {
        if (!existing.includes(definition.id)) existing.push(definition.id);
      } else {
        owners.set(chord, [definition.id]);
      }
    }
  }
  return [...owners.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([chord, ids]) => ({ chord, ids }));
}

const KEY_LABELS: Record<string, string> = {
  ' ': 'Space',
  arrowleft: '←',
  arrowright: '→',
  arrowup: '↑',
  arrowdown: '↓',
  escape: 'Esc',
  delete: 'Del',
  backspace: 'Backspace',
  home: 'Home',
  end: 'End',
  '\\': '\\',
};

/** Human-readable chord for the help panel, e.g. `Ctrl+Shift+X`. */
export function formatShortcut(binding: ShortcutBinding): string {
  const parts: string[] = [];
  if (binding.ctrl) parts.push('Ctrl');
  if (binding.alt) parts.push('Alt');
  if (binding.shift) parts.push('Shift');
  const normalized = normalizeKey(binding.key);
  parts.push(KEY_LABELS[normalized] ?? (normalized.length === 1 ? normalized.toUpperCase() : binding.key));
  return parts.join('+');
}

/** Primary chord per command, for compact UI labels and tooltips. */
export function primaryShortcutLabel(id: ShortcutId): string {
  const definition = SHORTCUTS.find((candidate) => candidate.id === id);
  return definition && definition.bindings[0] ? formatShortcut(definition.bindings[0]) : '';
}

/** Commands grouped by category, in catalogue order. */
export function shortcutsByCategory(
  shortcuts: readonly ShortcutDefinition[] = SHORTCUTS,
): { category: ShortcutCategory; items: ShortcutDefinition[] }[] {
  const groups = new Map<ShortcutCategory, ShortcutDefinition[]>();
  for (const definition of shortcuts) {
    const existing = groups.get(definition.category);
    if (existing) existing.push(definition);
    else groups.set(definition.category, [definition]);
  }
  return [...groups.entries()].map(([category, items]) => ({ category, items }));
}
