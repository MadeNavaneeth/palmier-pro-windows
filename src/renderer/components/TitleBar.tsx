import React from 'react';
import {
  Bot,
  ChevronDown,
  Columns3,
  PanelLeft,
  PanelRight,
  Save,
  Share2,
} from 'lucide-react';
import { useProjectStore } from '../store/project';
import { useUiStore } from '../store/ui';
import {
  LAYOUT_PRESET_INFO,
  layoutPresetInfo,
  type LayoutPreset,
} from '../../shared/ui/workspace-layout';

interface TitleBarProps {
  mediaVisible?: boolean;
  inspectorVisible?: boolean;
  agentVisible?: boolean;
  onToggleMedia?: () => void;
  onToggleInspector?: () => void;
  onToggleAgent?: () => void;
  onExport?: () => void;
}

export function TitleBar({
  mediaVisible = true,
  inspectorVisible = true,
  agentVisible = false,
  onToggleMedia,
  onToggleInspector,
  onToggleAgent,
  onExport,
}: TitleBarProps) {
  const { name, hasUnsavedChanges, isLoaded, save } = useProjectStore();

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
            onClick={() => save()}
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
        {onExport && (
          <button
            onClick={onExport}
            className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium text-text-secondary hover:bg-white/[0.08] hover:text-text-primary"
            title="Export"
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
