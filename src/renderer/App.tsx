import React, { useEffect, useRef, useState } from 'react';
import { Bot, PanelLeft, PanelRight, Share2 } from 'lucide-react';
import { TitleBar } from './components/TitleBar';
import { MediaBin } from './components/MediaBin';
import { Timeline } from './components/Timeline';
import { Preview } from './components/Preview';
import { WelcomeScreen } from './components/WelcomeScreen';
import { OnboardingTour } from './components/OnboardingTour';
import { ChatPanel, SettingsPanel } from './components/ai';
import { Inspector } from './components/Inspector';
import { ExportPanel } from './components/ExportDialog';
import { ShortcutHelpDialog } from './components/ShortcutHelpDialog';
import { CommandPalette } from './components/CommandPalette';
import { useProjectStore } from './store/project';
import { useUiStore, SPLITS_DEFAULTS, type PanelVisibility } from './store/ui';
import { PANEL_LABELS, type PanelGroup, type PanelKey } from '../shared/ui/panel-groups';
import type { LayoutPreset } from '../shared/ui/workspace-layout';
import { initAiListeners } from './store/ai';
import { useAutosave } from './hooks/useAutosave';
import { useEditorSync } from './hooks/useEditorSync';

export function App() {
  const { isLoaded } = useProjectStore();
  const [systemReady, setSystemReady] = useState(false);

  // Panel layout is persisted (upstream #286): working with a reduced layout is
  // the point of the request, and local state reset it on every launch.
  const panels = useUiStore((s) => s.panels);
  const togglePanel = useUiStore((s) => s.togglePanel);
  const groups = useUiStore((s) => s.groups);
  const layout = useUiStore((s) => s.layout);

  // Overlay visibility is shared with the keyboard layer (#164), which sits
  // outside this component and needs the same switches.
  const shortcutHelpOpen = useUiStore((s) => s.shortcutHelpOpen);
  const closeShortcutHelp = useUiStore((s) => s.closeShortcutHelp);

  // Debounced crash-recovery autosave (upstream #211).
  useAutosave();
  // Keep the main-process controller mirrored so agent/MCP edits show live.
  useEditorSync();

  useEffect(() => {
    // Check system readiness on mount
    async function init() {
      try {
        const ffmpeg = await window.palmier.system.checkFfmpeg();
        if (!ffmpeg.available) {
          console.warn('FFmpeg not found on PATH â€” media features will be limited.');
        }
        await window.palmier.system.gpuInit();
      } catch (err) {
        console.warn('System init partial failure:', err);
      }
      setSystemReady(true);
    }
    // Detached on purpose: an effect cannot be async. `init` handles its own
    // failures, and the catch here is the backstop so a throw outside that
    // try/block cannot leave the app stuck on the loading spinner.
    void init().catch((err: unknown) => {
      console.error('System init failed:', err);
      setSystemReady(true);
    });

    // Initialize AI event listeners
    const cleanup = initAiListeners();
    return cleanup;
  }, []);

  if (!systemReady) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-surface-0">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-surface-4 border-t-accent" />
          <p className="text-sm text-text-secondary">Initializing...</p>
        </div>
      </div>
    );
  }

  if (!isLoaded) {
    return (
      <div className="flex h-screen w-screen flex-col bg-surface-0">
        <TitleBar />
        <WelcomeScreen />
        <OnboardingTour />
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen flex-col bg-surface-0">
      <TitleBar
        mediaVisible={panels.media}
        inspectorVisible={panels.inspector}
        agentVisible={panels.agent}
        exportVisible={panels.export}
        onToggleMedia={() => togglePanel('media')}
        onToggleInspector={() => togglePanel('inspector')}
        onToggleAgent={() => togglePanel('agent')}
        onToggleExport={() => togglePanel('export')}
      />
      <div className="flex min-h-0 flex-1 gap-[5px] overflow-hidden p-[5px] pt-0">
        {/* The Agent region is always mounted (hidden when empty) and always the
            anchor of its own group, so regrouping never relocates ChatPanel's
            React parent. An in-progress chat therefore survives any tab change.
            This is the #286 constraint upstream called out; see PanelRegion. */}
        <PanelRegion
          anchor="agent"
          groups={groups}
          panels={panels}
          alwaysMounted
          className={`${PANEL_FRAME} min-h-0 w-[300px] min-w-[240px] shrink-0`}
          onCloseExport={() => togglePanel('export')}
        />
        <WorkspacePresetLayout
          layout={layout}
          groups={groups}
          panels={panels}
          onCloseExport={() => togglePanel('export')}
        />
        {/* Export docks on the right (#166): settings stay reachable while a
            render runs, which a modal could not offer. */}
        <PanelRegion
          anchor="export"
          groups={groups}
          panels={panels}
          className={`${PANEL_FRAME} min-h-0 w-[340px] min-w-[260px] shrink-0`}
          onCloseExport={() => togglePanel('export')}
        />
      </div>

      <SettingsPanel />
      <ShortcutHelpDialog isOpen={shortcutHelpOpen} onClose={closeShortcutHelp} />
      <CommandPalette />
    </div>
  );
}

const PANEL_FRAME = 'flex flex-col overflow-hidden bg-surface-1';

/**
 * Panel sizing floors.
 *
 * The side panels used to be `shrink-0` at a viewport-relative width, which is
 * fine until enough of them are open at once: at 1024 px with the Agent panel
 * showing, media + inspector + a 400 px preview asks for more than the row has,
 * and because the row is `overflow-hidden` the excess was silently clipped
 * instead of scrolling â€” the rightmost panel simply left the window. Rendered
 * checks missed it because they measured document scrollbars and the two toolbar
 * rows, not the workspace row itself.
 *
 * So the panels shrink under pressure down to a stated floor, and nothing is
 * rigid except the Agent column, which is already at its minimum useful width.
 *
 * Since #286's resizable-splitters work, each side panel's preferred width is
 * user-owned state (`ui.splits`) applied as an explicit basis; the viewport-
 * relative clamps are gone. Under pressure flex still wins over the basis down
 * to these floors, so nothing can be dragged or squeezed out of the window.
 */
/** Narrowest a side panel is allowed to be squeezed to. */
const PANEL_FLOOR = 'min-w-[200px]';
/**
 * Narrowest preview worth showing.
 *
 * Set by the transport row rather than by taste: at its narrowest container tier
 * that row still needs about 290px for the timecode, the five transport buttons
 * and the guides menu, and a preview narrower than its own controls is not a
 * usable state to offer.
 */
const PREVIEW_MIN = 'min-w-[300px]';
/** Preview floor + gap + inspector floor. */
const PREVIEW_WITH_INSPECTOR_MIN = 'min-w-[505px]';

/**
 * One draggable workspace divider (upstream #286).
 *
 * Pointer capture keeps the drag alive outside the element; deltas stream into
 * the store clamped, so the persisted value is always one the layout honors.
 * Double-click restores that divider's default position. The strip occupies the
 * same 5 px the flex gaps it replaces used, so first-run geometry is unchanged.
 */
function Divider({
  axis,
  apply,
  reset,
}: {
  axis: 'x' | 'y';
  /** Feed a pointer delta to the owning split; sign/direction live here. */
  apply: (delta: number) => void;
  reset: () => void;
}) {
  const dragging = useRef(false);
  const last = useRef(0);

  const position = (event: React.PointerEvent<HTMLDivElement>) =>
    axis === 'x' ? event.clientX : event.clientY;

  return (
    <div
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      data-workspace-divider={axis}
      className={
        axis === 'x'
          ? 'w-[5px] shrink-0 cursor-col-resize rounded bg-transparent transition-colors hover:bg-white/15'
          : 'h-[5px] shrink-0 cursor-row-resize rounded bg-transparent transition-colors hover:bg-white/15'
      }
      onDoubleClick={reset}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragging.current = true;
        last.current = position(event);
      }}
      onPointerMove={(event) => {
        if (!dragging.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const current = position(event);
        apply(current - last.current);
        last.current = current;
      }}
      onPointerUp={(event) => {
        dragging.current = false;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
    />
  );
}

/** Hook the divider before the Inspector: dragging toward the preview narrows it. */
function InspectorDivider() {
  const width = useUiStore((state) => state.splits.inspectorWidth);
  const setSplit = useUiStore((state) => state.setSplit);
  return (
    <Divider
      axis="x"
      apply={(delta) => setSplit('inspectorWidth', width - delta)}
      reset={() => setSplit('inspectorWidth', SPLITS_DEFAULTS.inspectorWidth)}
    />
  );
}

/** The horizontal divider above a bottom-docked timeline: down grows it. */
function TimelineDivider() {
  const height = useUiStore((state) => state.splits.timelineHeight);
  const setSplit = useUiStore((state) => state.setSplit);
  return (
    <Divider
      axis="y"
      apply={(delta) => setSplit('timelineHeight', height + delta)}
      reset={() => setSplit('timelineHeight', SPLITS_DEFAULTS.timelineHeight)}
    />
  );
}

/** The vertical divider left of the vertical preset's preview column. */
function PreviewColumnDivider() {
  const width = useUiStore((state) => state.splits.previewWidth);
  const setSplit = useUiStore((state) => state.setSplit);
  return (
    <Divider
      axis="x"
      apply={(delta) => setSplit('previewWidth', width - delta)}
      reset={() => setSplit('previewWidth', SPLITS_DEFAULTS.previewWidth)}
    />
  );
}

/**
 * One tab region (upstream #286).
 *
 * A region is the group anchored at `anchor`: every visible member renders as a
 * tab, and only the active member is shown. Regions without visible members are
 * not rendered at all, so a group whose panels are all hidden leaves no gap.
 *
 * `alwaysMounted` is the Agent's escape hatch: its region stays in the DOM and
 * hides itself when empty, so `ChatPanel` is never unmounted by hiding or by
 * regrouping. The chat tab panel is rendered outside the member map for the same
 * reason — switching tabs must move focus, not tear the conversation down.
 */
function PanelRegion({
  anchor,
  groups,
  panels,
  className,
  style,
  alwaysMounted = false,
  onCloseExport,
}: {
  anchor: PanelKey;
  groups: readonly PanelGroup[];
  panels: PanelVisibility;
  className: string;
  style?: React.CSSProperties;
  alwaysMounted?: boolean;
  onCloseExport: () => void;
}) {
  const group = groups.find((entry) => entry[0] === anchor);
  const visible = group ? group.filter((panel) => panels[panel]) : [];
  const [active, setActive] = useState<PanelKey>(anchor);
  // A hidden active tab falls back to the first still-visible member.
  const activeMember = visible.includes(active) ? active : visible[0];
  const empty = visible.length === 0;
  const tabbed = visible.length > 1;
  // Only decorate as a tab panel when there is a tab strip to control it.
  const tabPanelProps = (panel: PanelKey): React.HTMLAttributes<HTMLDivElement> =>
    tabbed
      ? {
          role: 'tabpanel',
          id: `panel-${anchor}-${panel}`,
          'aria-labelledby': `tab-${anchor}-${panel}`,
        }
      : {};

  // Only an actual anchor owns a region. A panel that has been folded into
  // another group (or a stale stored value) must not leave a phantom column
  // behind, which would also render that panel twice.
  if (!group) return null;
  if (empty && !alwaysMounted) return null;

  return (
    <section
      aria-label={`${PANEL_LABELS[anchor]} panel region`}
      data-panel-region={anchor}
      data-export-panel={anchor === 'export' ? '' : undefined}
      // Inline display rather than the `hidden` class: both `hidden` and `flex`
      // are plain display utilities, and which one wins would depend on the
      // generated stylesheet's order.
      style={empty ? { ...style, display: 'none' } : style}
      className={`${PANEL_FRAME} min-h-0 ${className}`}
    >
      {tabbed && (
        <PanelTabs anchor={anchor} members={visible} active={activeMember} onSelect={setActive} />
      )}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* Never unmount this one. An in-progress turn, its transcript, and the
            composer draft live under this wrapper; regrouping must not remount
            ChatPanel, which is why the Agent is always the anchor of its group. */}
        {anchor === 'agent' && (
          <div
            {...tabPanelProps('agent')}
            className="flex min-h-0 flex-1 flex-col"
            style={activeMember === 'agent' ? undefined : { display: 'none' }}
          >
            <ChatPanel />
          </div>
        )}
        {visible
          .filter((panel) => panel !== 'agent')
          .map((panel) => (
            <div
              key={panel}
              {...tabPanelProps(panel)}
              className="flex min-h-0 flex-1 flex-col"
              style={activeMember === panel ? undefined : { display: 'none' }}
            >
              <PanelBody panel={panel} onCloseExport={onCloseExport} />
            </div>
          ))}
      </div>
    </section>
  );
}

/** Panel chrome inside a tab panel. The Agent is owned by AgentPanelRegion. */
function PanelBody({ panel, onCloseExport }: { panel: PanelKey; onCloseExport: () => void }) {
  switch (panel) {
    case 'media':
      return <MediaBin />;
    case 'inspector':
      return <Inspector />;
    case 'export':
      return <ExportPanel onClose={onCloseExport} />;
    case 'agent':
      return <ChatPanel />;
  }
}

function PanelIcon({ panel, size = 12 }: { panel: PanelKey; size?: number }) {
  switch (panel) {
    case 'media':
      return <PanelLeft size={size} strokeWidth={1.8} aria-hidden="true" />;
    case 'inspector':
      return <PanelRight size={size} strokeWidth={1.8} aria-hidden="true" />;
    case 'agent':
      return <Bot size={size} strokeWidth={1.8} aria-hidden="true" />;
    case 'export':
      return <Share2 size={size} strokeWidth={1.8} aria-hidden="true" />;
  }
}

/**
 * The tab headers for one region.
 *
 * Real tabs, not buttons: `role="tablist"`/`role="tab"` with roving tabindex, so
 * Left/Right/Home/End move between panels and focus stays inside the strip. The
 * active tab is carried by a filled background (surface-1, matching the panel
 * below it) plus an accent bar, which stays legible at both matrix sizes.
 */
function PanelTabs({
  anchor,
  members,
  active,
  onSelect,
}: {
  anchor: PanelKey;
  members: PanelKey[];
  active: PanelKey | undefined;
  onSelect: (panel: PanelKey) => void;
}) {
  const tabRefs = useRef(new Map<PanelKey, HTMLButtonElement>());

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (!active) return;
    const index = members.indexOf(active);
    let next: PanelKey | undefined;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      next = members[(index + 1) % members.length];
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      next = members[(index - 1 + members.length) % members.length];
    } else if (event.key === 'Home') {
      next = members[0];
    } else if (event.key === 'End') {
      next = members[members.length - 1];
    }
    if (!next) return;
    event.preventDefault();
    if (next === active) return;
    onSelect(next);
    tabRefs.current.get(next)?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={`${PANEL_LABELS[anchor]} panel tabs`}
      onKeyDown={handleKeyDown}
      className="flex h-7 shrink-0 items-stretch gap-px border-b border-white/10 bg-surface-2 px-1"
    >
      {members.map((panel) => {
        const selected = panel === active;
        return (
          <button
            key={panel}
            ref={(element) => {
              if (element) tabRefs.current.set(panel, element);
              else tabRefs.current.delete(panel);
            }}
            role="tab"
            id={`tab-${anchor}-${panel}`}
            aria-selected={selected}
            aria-controls={`panel-${anchor}-${panel}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(panel)}
            title={PANEL_LABELS[panel]}
            className={`relative flex min-w-0 flex-1 items-center justify-center gap-1 rounded-t px-2 text-[10px] transition-colors ${
              selected
                ? 'bg-surface-1 font-medium text-text-primary'
                : 'text-text-muted hover:bg-white/[0.06] hover:text-text-secondary'
            }`}
          >
            {selected && (
              <span aria-hidden="true" className="absolute inset-x-1 top-0 h-[2px] rounded-full bg-accent" />
            )}
            <PanelIcon panel={panel} />
            <span className="truncate">{PANEL_LABELS[panel]}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The three arrangements from upstream PR #430, now separated by draggable
 * dividers (#286). Each divider owns exactly one stored dimension; the panel
 * on its "free" side absorbs slack via flex, so a drag never fights the
 * pressure-shrink floors.
 *
 * The media and inspector slots render the tab regions anchored there, so a
 * group placed in one of them reuses that slot's stored split width — a group
 * never invents a width of its own.
 */
function WorkspacePresetLayout({
  layout,
  groups,
  panels,
  onCloseExport,
}: {
  layout: LayoutPreset;
  groups: readonly PanelGroup[];
  panels: PanelVisibility;
  onCloseExport: () => void;
}) {
  const splits = useUiStore((state) => state.splits);

  const regionHasVisible = (anchor: PanelKey) => {
    const group = groups.find((entry) => entry[0] === anchor);
    return group ? group.some((panel) => panels[panel]) : false;
  };
  const hasMedia = regionHasVisible('media');
  const hasInspector = regionHasVisible('inspector');

  const media = (
    <PanelRegion
      anchor="media"
      groups={groups}
      panels={panels}
      className={PANEL_FLOOR}
      style={{ width: splits.mediaWidth }}
      onCloseExport={onCloseExport}
    />
  );

  const inspector = (
    <PanelRegion
      anchor="inspector"
      groups={groups}
      panels={panels}
      className={PANEL_FLOOR}
      style={{ width: splits.inspectorWidth }}
      onCloseExport={onCloseExport}
    />
  );

  const hasSidePanel = hasMedia || hasInspector;

  // Below-the-panels timeline dock: its divider feeds timelineHeight.
  const timelineBelow = (
    <>
      <TimelineDivider />
      <Timeline height={splits.timelineHeight} />
    </>
  );

  if (layout === 'media') {
    // [Media] | [Preview | Inspector] / [Timeline]
    // Media runs the full height, which is what makes sifting through a large
    // bin bearable.
    return (
      <div className="flex min-h-0 min-w-0 flex-1">
        {media}
        {hasMedia && <Gap />}
        <div className={`flex min-h-0 flex-1 flex-col ${hasInspector ? PREVIEW_WITH_INSPECTOR_MIN : PREVIEW_MIN}`}>
          <div className="flex min-h-0 flex-1">
            <main className={`flex min-h-0 flex-1 flex-col ${PREVIEW_MIN}`}>
              <Preview />
            </main>
            {hasInspector && <InspectorDivider />}
            {inspector}
          </div>
          {timelineBelow}
        </div>
      </div>
    );
  }

  if (layout === 'vertical') {
    // [Media | Inspector] / [Timeline] | [Preview]
    // The preview takes a tall right-hand column so a 9:16 frame is shown large
    // instead of being letterboxed into a wide box.
    return (
      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {hasSidePanel ? (
            <>
              <div className="flex min-h-0 flex-1">
                {media}
                {hasMedia && hasInspector && <Gap />}
                {inspector}
              </div>
              {timelineBelow}
            </>
          ) : (
            /* Nothing else claims this column when both side panels are hidden, so
               the timeline takes the height instead of leaving it blank. */
            <Timeline fill />
          )}
        </div>
        <PreviewColumnDivider />
        <main
          className={`flex min-h-0 flex-col ${PREVIEW_MIN}`}
          style={{ width: splits.previewWidth }}
        >
          <Preview />
        </main>
      </div>
    );
  }

  // Default: [Media | Preview | Inspector] / [Timeline]
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      {media}
      {hasMedia && <Gap />}
      <main className={`flex min-h-0 min-w-0 flex-1 flex-col ${PREVIEW_MIN}`}>
        <Preview />
        {timelineBelow}
      </main>
      {hasInspector && <InspectorDivider />}
      {inspector}
    </div>
  );
}

/** The visual gap a Divider replaces where no resizable boundary exists. */
function Gap() {
  return <div className="w-[5px] shrink-0" />;
}


