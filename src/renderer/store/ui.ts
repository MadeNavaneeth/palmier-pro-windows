/**
 * UI store — visibility of app-level overlays.
 *
 * These flags used to be `useState` inside App, which meant only App's own
 * buttons could open a dialog. The keyboard layer (upstream #164) lives outside
 * that component and needs the same switches, so ownership moved here rather
 * than threading callbacks down through the tree.
 *
 * Workspace arrangement lives here for a different reason: it is persisted, so it
 * has to outlive any one component's mount.
 */

import { create } from 'zustand';
import { asGuideKind, type GuideKind } from '../../shared/preview/guides';
import {
  DEFAULT_LAYOUT,
  asLayoutPreset,
  type LayoutPreset,
} from '../../shared/ui/workspace-layout';

const GUIDES_STORAGE_KEY = 'palmier.preview.guides';
const PANELS_STORAGE_KEY = 'palmier.layout.panels';
const LAYOUT_STORAGE_KEY = 'palmier.layout.preset';

/** Persisted layout preset, or the default when unset or unrecognized. */
function loadLayout(): LayoutPreset {
  try {
    return asLayoutPreset(window.localStorage?.getItem(LAYOUT_STORAGE_KEY)) ?? DEFAULT_LAYOUT;
  } catch {
    return DEFAULT_LAYOUT;
  }
}

function saveLayout(preset: LayoutPreset): void {
  try {
    window.localStorage?.setItem(LAYOUT_STORAGE_KEY, preset);
  } catch {
    // A full or unavailable storage quota must not break the switch itself.
  }
}

/** The side panels a user can show or hide (upstream #286). */
export type PanelKey = 'media' | 'inspector' | 'agent';

export type PanelVisibility = Record<PanelKey, boolean>;

const PANEL_KEYS: readonly PanelKey[] = ['media', 'inspector', 'agent'];

/** Media and Inspector in, Agent out — the first-run editing layout. */
const DEFAULT_PANELS: PanelVisibility = { media: true, inspector: true, agent: false };

/**
 * Read the persisted panel layout, keeping only recognized boolean flags.
 *
 * Same treatment as the guide set: the stored value is user-writable and may
 * have been written by a build with a different set of panels, so each key is
 * narrowed rather than trusted. Anything unusable falls back to that panel's
 * default instead of preventing the app from starting.
 */
function loadPanels(): PanelVisibility {
  try {
    const raw = window.localStorage?.getItem(PANELS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PANELS };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_PANELS };
    const stored = parsed as Partial<Record<PanelKey, unknown>>;
    const panels = { ...DEFAULT_PANELS };
    for (const key of PANEL_KEYS) {
      if (typeof stored[key] === 'boolean') panels[key] = stored[key];
    }
    return panels;
  } catch {
    return { ...DEFAULT_PANELS };
  }
}

function savePanels(panels: PanelVisibility): void {
  try {
    window.localStorage?.setItem(PANELS_STORAGE_KEY, JSON.stringify(panels));
  } catch {
    // A full or unavailable storage quota must not break the toggle itself.
  }
}

/**
 * Read persisted guide selection, discarding anything unrecognized.
 *
 * The stored value is user-writable and may have been written by a different
 * build, so each entry is narrowed rather than trusted. A parse failure falls
 * back to no guides instead of preventing the app from starting.
 */
function loadGuides(): Set<GuideKind> {
  try {
    const raw = window.localStorage?.getItem(GUIDES_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    const kinds = parsed.map(asGuideKind).filter((kind): kind is GuideKind => kind !== null);
    return new Set(kinds);
  } catch {
    return new Set();
  }
}

function saveGuides(guides: ReadonlySet<GuideKind>): void {
  try {
    window.localStorage?.setItem(GUIDES_STORAGE_KEY, JSON.stringify([...guides]));
  } catch {
    // A full or unavailable storage quota must not break the toggle itself.
  }
}

interface UiState {
  /** Export dialog (Ctrl+M, or the title bar Export button). */
  exportOpen: boolean;
  /** Keyboard shortcut reference (F1 or ?). */
  shortcutHelpOpen: boolean;
  /**
   * Composition guides drawn over the preview (#167).
   *
   * View-only: the set is read by the preview overlay and never reaches the
   * compositor or the exporter, so guides cannot be baked into an output file.
   */
  guides: ReadonlySet<GuideKind>;
  /**
   * Which side panels are showing (upstream #286).
   *
   * Persisted, because the request is to be able to work in a reduced layout —
   * "only the timeline and video in view" — and a layout that resets on every
   * launch means re-hiding the same panels each time. Ownership sits here rather
   * than in App so the state survives a remount and can be read from anywhere.
   */
  panels: PanelVisibility;
  /**
   * How the workspace is arranged (upstream PR #430).
   *
   * Orthogonal to `panels`: the preset decides where things sit, the toggles
   * decide which of them are present.
   */
  layout: LayoutPreset;

  openExport: () => void;
  closeExport: () => void;
  openShortcutHelp: () => void;
  closeShortcutHelp: () => void;
  toggleShortcutHelp: () => void;
  toggleGuide: (kind: GuideKind) => void;
  /** Show or hide both safe-area guides together. */
  setSafeAreaGuides: (visible: boolean) => void;
  clearGuides: () => void;
  togglePanel: (panel: PanelKey) => void;
  /** Restore the first-run layout. */
  resetPanels: () => void;
  setLayout: (preset: LayoutPreset) => void;
}

export const useUiStore = create<UiState>((set) => ({
  exportOpen: false,
  shortcutHelpOpen: false,
  guides: loadGuides(),
  panels: loadPanels(),
  layout: loadLayout(),

  // Only one modal is meaningful at a time; opening one dismisses the other so
  // a stacked pair can't trap focus or leave an unreachable close button.
  openExport: () => set({ exportOpen: true, shortcutHelpOpen: false }),
  closeExport: () => set({ exportOpen: false }),
  openShortcutHelp: () => set({ shortcutHelpOpen: true, exportOpen: false }),
  closeShortcutHelp: () => set({ shortcutHelpOpen: false }),
  toggleShortcutHelp: () =>
    set((state) => ({ shortcutHelpOpen: !state.shortcutHelpOpen, exportOpen: false })),

  // Replaced rather than mutated, so subscribers actually see the change.
  toggleGuide: (kind) =>
    set((state) => {
      const next = new Set(state.guides);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      saveGuides(next);
      return { guides: next };
    }),

  setSafeAreaGuides: (visible) =>
    set((state) => {
      const next = new Set(state.guides);
      for (const kind of ['actionSafe', 'titleSafe'] as const) {
        if (visible) next.add(kind);
        else next.delete(kind);
      }
      saveGuides(next);
      return { guides: next };
    }),

  clearGuides: () =>
    set(() => {
      const next = new Set<GuideKind>();
      saveGuides(next);
      return { guides: next };
    }),

  togglePanel: (panel) =>
    set((state) => {
      const next = { ...state.panels, [panel]: !state.panels[panel] };
      savePanels(next);
      return { panels: next };
    }),

  resetPanels: () =>
    set(() => {
      const next = { ...DEFAULT_PANELS };
      savePanels(next);
      return { panels: next };
    }),

  setLayout: (preset) =>
    set((state) => {
      // Guarded so a bad value from a caller cannot persist and then be read
      // back as the active layout on the next launch.
      const next = asLayoutPreset(preset);
      if (next === null || next === state.layout) return {};
      saveLayout(next);
      return { layout: next };
    }),
}));
