import React, { useEffect, useRef, useState } from 'react';
import {
  Bot,
  ChevronDown,
  Columns3,
  PanelLeft,
  PanelRight,
  PanelsTopLeft,
  Save,
  Share2,
  SunMoon,
} from 'lucide-react';
import { useAiStore } from '../store/ai';
import { useProjectStore } from '../store/project';
import { useUiStore } from '../store/ui';
import { dispatchShortcut } from '../lib/shortcut-dispatcher';
import {
  isDetachablePanel,
  type DetachablePanel,
} from '../../shared/ui/detached-panels';
import {
  PANEL_KEYS,
  PANEL_LABELS,
  othersInRegion,
  type PanelKey,
} from '../../shared/ui/panel-groups';
import {
  LAYOUT_PRESET_INFO,
  layoutPresetInfo,
  type LayoutPreset,
} from '../../shared/ui/workspace-layout';
import {
  APPEARANCE_INFO,
  appearanceInfo,
  type Appearance,
} from '../lib/appearance';

interface TitleBarProps {
  mediaVisible?: boolean;
  inspectorVisible?: boolean;
  agentVisible?: boolean;
  exportVisible?: boolean;
  onToggleMedia?: () => void;
  onToggleInspector?: () => void;
  onToggleAgent?: () => void;
  /** Toggle the export workspace panel (#166) — no longer a modal. */
  onToggleExport?: () => void;
}

export function TitleBar({
  mediaVisible = true,
  inspectorVisible = true,
  agentVisible = false,
  exportVisible = false,
  onToggleMedia,
  onToggleInspector,
  onToggleAgent,
  onToggleExport,
}: TitleBarProps) {
  const { name, hasUnsavedChanges, isLoaded } = useProjectStore();

  return (
    <header className="drag-region relative flex h-11 shrink-0 items-center border-b border-white/10 bg-surface-1 px-3">
      <div className="no-drag flex w-52 items-center gap-1">
        {onToggleAgent && (
          <button
            className="icon-button"
            data-active={agentVisible}
            onClick={onToggleAgent}
            title="Toggle Agent Panel"
            aria-label="Toggle Agent Panel"
          >
            <Bot size={15} strokeWidth={1.7} />
          </button>
        )}
        {onToggleMedia && (
          <button
            className="icon-button"
            data-active={mediaVisible}
            onClick={onToggleMedia}
            title="Toggle Media Panel"
            aria-label="Toggle Media Panel"
          >
            <PanelLeft size={15} strokeWidth={1.7} />
          </button>
        )}
      </div>

      <button
        className="no-drag absolute left-1/2 flex -translate-x-1/2 items-center gap-1 rounded px-2 py-1 text-[11px] font-medium text-text-secondary hover:bg-white/[0.06] hover:text-text-primary"
        title={hasUnsavedChanges ? 'Project has unsaved changes' : 'Project saved'}
      >
        <span className="max-w-72 truncate">{name}</span>
        {hasUnsavedChanges && <span className="text-timecode">•</span>}
        <ChevronDown size={12} strokeWidth={1.7} className="text-text-muted" />
      </button>

      <div className="no-drag ml-auto flex items-center gap-1.5">
        {isLoaded && (
          <button
            onClick={() => dispatchShortcut('saveProject')}
            className="icon-button"
            title="Save project (Ctrl+S)"
            aria-label="Save project"
          >
            <Save size={14} strokeWidth={1.7} />
          </button>
        )}
        {onToggleInspector && (
          <button
            className="icon-button"
            data-active={inspectorVisible}
            onClick={onToggleInspector}
            title="Toggle Inspector"
            aria-label="Toggle Inspector"
          >
            <PanelRight size={15} strokeWidth={1.7} />
          </button>
        )}
        <LayoutSwitcher />
        <ThemeSwitcher />
        <PanelArrangementMenu />
        {onToggleExport && (
          <button
            onClick={onToggleExport}
            className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium text-text-secondary hover:bg-white/[0.08] hover:text-text-primary"
            data-active={exportVisible}
            title="Toggle export panel (Ctrl+M)"
            aria-label="Toggle export panel"
          >
            <Share2 size={14} strokeWidth={1.7} />
            Export
          </button>
        )}
        <div
          className="ml-1 flex h-6 w-6 items-center justify-center rounded-full border border-white/15 bg-surface-3 text-[9px] font-semibold text-text-secondary"
          title="Account"
        >
          P
        </div>
      </div>
    </header>
  );
}

/**
 * Workspace arrangement picker (upstream PR #430).
 *
 * A native select rather than a custom menu: it is a single-choice control, and
 * the platform widget already gives keyboard navigation, type-ahead and screen
 * reader semantics for free. The Ctrl+digit chords are shown in the option labels
 * so the shortcut is discoverable from the control it duplicates.
 */
function LayoutSwitcher() {
  const layout = useUiStore((s) => s.layout);
  const setLayout = useUiStore((s) => s.setLayout);

  return (
    <span className="flex h-7 items-center gap-1 rounded-md px-1.5 text-[11px] text-text-secondary hover:bg-white/[0.08] hover:text-text-primary">
      <Columns3 size={14} strokeWidth={1.7} aria-hidden="true" />
      <select
        value={layout}
        // The store narrows the value, so a stale option from a previous build
        // cannot become the active layout.
        onChange={(event) => setLayout(event.target.value as LayoutPreset)}
        aria-label="Workspace layout"
        title={layoutPresetInfo(layout).description}
        className="cursor-pointer bg-transparent text-[11px] text-inherit outline-none"
      >
        {LAYOUT_PRESET_INFO.map((entry) => (
          <option key={entry.id} value={entry.id} className="bg-surface-2 text-text-primary">
            {entry.label} (Ctrl+{entry.digit})
          </option>
        ))}
      </select>
    </span>
  );
}

/**
 * Theme picker (upstream PR #430's AppearancePane, Theme group).
 *
 * Same shape as the workspace switcher beside it: a native select so keyboard
 * navigation, type-ahead and screen reader semantics come free. System follows
 * the OS live; Light and Dark pin the override. The store narrows the value,
 * so a stale choice from a previous build cannot become the active theme.
 */
function ThemeSwitcher() {
  const appearance = useUiStore((s) => s.appearance);
  const setAppearance = useUiStore((s) => s.setAppearance);

  return (
    <span
      className="flex h-7 items-center gap-1 rounded-md px-1.5 text-[11px] text-text-secondary hover:bg-white/[0.08] hover:text-text-primary"
      data-theme-switcher
    >
      <SunMoon size={14} strokeWidth={1.7} aria-hidden="true" />
      <select
        value={appearance}
        onChange={(event) => setAppearance(event.target.value as Appearance)}
        aria-label="Appearance"
        title={appearanceInfo(appearance).description}
        className="cursor-pointer bg-transparent text-[11px] text-inherit outline-none"
      >
        {APPEARANCE_INFO.map((entry) => (
          <option key={entry.id} value={entry.id} className="bg-surface-2 text-text-primary">
            {entry.label}
          </option>
        ))}
      </select>
    </span>
  );
}

function PanelMenuIcon({ panel }: { panel: PanelKey }) {
  switch (panel) {
    case 'media':
      return <PanelLeft size={13} strokeWidth={1.8} aria-hidden="true" />;
    case 'inspector':
      return <PanelRight size={13} strokeWidth={1.8} aria-hidden="true" />;
    case 'agent':
      return <Bot size={13} strokeWidth={1.8} aria-hidden="true" />;
    case 'export':
      return <Share2 size={13} strokeWidth={1.8} aria-hidden="true" />;
  }
}

/**
 * Panel tab grouping control (upstream #286's "turn the components into tabs").
 *
 * An explicit picker rather than drag-to-dock, matching the choice upstream made
 * for the layout presets: each panel says which other panel it shares a region
 * with, and "Standalone" splits it back out. A native select per row keeps the
 * whole thing keyboard-reachable and screen-reader legible without a custom
 * listbox. The Agent row reads the same as any other, but the store keeps the
 * Agent anchored to its own region so its chat is never remounted.
 */
function PanelArrangementMenu() {
  const groups = useUiStore((s) => s.groups);
  const panels = useUiStore((s) => s.panels);
  const assignPanel = useUiStore((s) => s.assignPanel);
  const detached = useUiStore((s) => s.detached);
  // A transcript captured mid-turn would miss the answer it was moving for,
  // so the agent cannot move while one is streaming (the main process refuses
  // it too; this is the affordance).
  const agentBusy = useAiStore((s) => s.isStreaming);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  // The main window follows the broadcast, so the result needs no local
  // handling here: a rejected call simply leaves the panel where it is.
  const detachPanel = (panel: DetachablePanel) => {
    void window.palmier.panels.detach(panel).catch(() => {});
  };
  const attachPanel = (panel: DetachablePanel) => {
    void window.palmier.panels.attach(panel).catch(() => {});
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && open) {
            event.stopPropagation();
            setOpen(false);
          }
        }}
        className="flex h-7 items-center gap-1 rounded-md px-1.5 text-[11px] text-text-secondary transition hover:bg-white/[0.08] hover:text-text-primary"
        title="Group panels into tabs"
        aria-label="Group panels into tabs"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <PanelsTopLeft size={14} strokeWidth={1.7} />
        <span>Panels</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Panel tabs"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              setOpen(false);
            }
          }}
          className="absolute right-0 top-full z-50 mt-1 w-64 rounded-md border border-surface-3 bg-surface-2 p-1 shadow-2xl"
        >
          <p className="px-2 pb-1 pt-1.5 text-[10px] leading-4 text-text-muted">
            Put panels in the same region to show them as tabs.
          </p>
          {PANEL_KEYS.map((panel) => {
            const others = othersInRegion(groups, panel);
            const value = others[0] ?? 'standalone';
            const isDetached = isDetachablePanel(panel) && detached.includes(panel);
            return (
              <div key={panel}>
                {/* A detached panel has no region to pick: it lives in its own
                    window, so the row shows that state instead of the tab
                    picker. */}
                {isDetached ? (
                  <div className="flex items-center justify-between gap-2 rounded px-2 py-1">
                    <span className="flex items-center gap-1.5 text-[11px] text-text-secondary">
                      <PanelMenuIcon panel={panel} />
                      {PANEL_LABELS[panel]}
                    </span>
                    <span className="text-[10px] text-text-muted">In its own window</span>
                  </div>
                ) : (
                  <label
                    className={`flex items-center justify-between gap-2 rounded px-2 py-1 ${
                      panels[panel] ? '' : 'opacity-50'
                    }`}
                  >
                    <span className="flex items-center gap-1.5 text-[11px] text-text-secondary">
                      <PanelMenuIcon panel={panel} />
                      {PANEL_LABELS[panel]}
                    </span>
                    <select
                      value={value}
                      onChange={(event) => {
                        const next = event.target.value;
                        assignPanel(panel, next === 'standalone' ? panel : (next as PanelKey));
                      }}
                      aria-label={`${PANEL_LABELS[panel]} region`}
                      className="cursor-pointer rounded border border-white/12 bg-surface-0 px-1 py-0.5 text-[10px] text-text-secondary outline-none hover:border-white/25"
                    >
                      <option value="standalone">Standalone</option>
                      {PANEL_KEYS.filter((other) => other !== panel).map((other) => (
                        <option key={other} value={other}>
                          With {PANEL_LABELS[other]}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {isDetachablePanel(panel) && (
                  <div className="px-2 pb-1">
                    {isDetached ? (
                      <button
                        type="button"
                        onClick={() => attachPanel(panel)}
                        className="text-[10px] text-text-secondary underline decoration-white/25 underline-offset-2 hover:text-text-primary"
                      >
                        Move back to workspace
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => detachPanel(panel)}
                        disabled={panel === 'agent' && agentBusy}
                        title={
                          panel === 'agent' && agentBusy
                            ? 'A turn is in progress. Stop it before moving the chat.'
                            : undefined
                        }
                        className="text-[10px] text-text-muted hover:text-text-secondary disabled:opacity-40 disabled:hover:text-text-muted"
                      >
                        Open in new window
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
