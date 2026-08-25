import React, { useEffect, useRef, useState } from 'react';
import { TitleBar } from './components/TitleBar';
import { MediaBin } from './components/MediaBin';
import { Timeline } from './components/Timeline';
import { Preview } from './components/Preview';
import { WelcomeScreen } from './components/WelcomeScreen';
import { ChatPanel, SettingsPanel } from './components/ai';
import { Inspector } from './components/Inspector';
import { ExportDialog } from './components/ExportDialog';
import { ShortcutHelpDialog } from './components/ShortcutHelpDialog';
import { useProjectStore } from './store/project';
import { useUiStore, SPLITS_DEFAULTS, type PanelVisibility } from './store/ui';
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
  const layout = useUiStore((s) => s.layout);

  // Overlay visibility is shared with the keyboard layer (#164), which sits
  // outside this component and needs the same switches.
  const exportOpen = useUiStore((s) => s.exportOpen);
  const shortcutHelpOpen = useUiStore((s) => s.shortcutHelpOpen);
  const openExport = useUiStore((s) => s.openExport);
  const closeExport = useUiStore((s) => s.closeExport);
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
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen flex-col bg-surface-0">
      <TitleBar
        mediaVisible={panels.media}
        inspectorVisible={panels.inspector}
        agentVisible={panels.agent}
        onToggleMedia={() => togglePanel('media')}
        onToggleInspector={() => togglePanel('inspector')}
        onToggleAgent={() => togglePanel('agent')}
        onExport={openExport}
      />
      <div className="flex min-h-0 flex-1 gap-[5px] overflow-hidden p-[5px] pt-0">
        {/* The Agent panel is a sibling column of the preset, not part of it, so
            switching arrangement never moves or closes an in-progress chat. */}
        {panels.agent && (
          <aside className="flex w-[300px] min-w-[240px] flex-col overflow-hidden bg-surface-1">
            <ChatPanel />
          </aside>
        )}
        <WorkspacePresetLayout layout={layout} panels={panels} />
      </div>

      <SettingsPanel />
      <ExportDialog isOpen={exportOpen} onClose={closeExport} />
      <ShortcutHelpDialog isOpen={shortcutHelpOpen} onClose={closeShortcutHelp} />
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
 * The three arrangements from upstream PR #430, now separated by draggable
 * dividers (#286). Each divider owns exactly one stored dimension; the panel
 * on its "free" side absorbs slack via flex, so a drag never fights the
 * pressure-shrink floors.
 */
function WorkspacePresetLayout({
  layout,
  panels,
}: {
  layout: LayoutPreset;
  panels: PanelVisibility;
}) {
  const splits = useUiStore((state) => state.splits);

  const media = panels.media ? (
    <aside
      className={`${PANEL_FRAME} min-h-0 ${PANEL_FLOOR}`}
      style={{ width: splits.mediaWidth }}
    >
      <MediaBin />
    </aside>
  ) : null;

  const inspector = panels.inspector ? (
    <aside
      className={`${PANEL_FRAME} min-h-0 ${PANEL_FLOOR}`}
      style={{ width: splits.inspectorWidth }}
    >
      <Inspector />
    </aside>
  ) : null;

  const hasSidePanel = media !== null || inspector !== null;

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
        {media && <Gap />}
        <div className={`flex min-h-0 flex-1 flex-col ${inspector ? PREVIEW_WITH_INSPECTOR_MIN : PREVIEW_MIN}`}>
          <div className="flex min-h-0 flex-1">
            <main className={`flex min-h-0 flex-1 flex-col ${PREVIEW_MIN}`}>
              <Preview />
            </main>
            {inspector && <InspectorDivider />}
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
                {media && inspector && <Gap />}
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
      {media && <Gap />}
      <main className={`flex min-h-0 min-w-0 flex-1 flex-col ${PREVIEW_MIN}`}>
        <Preview />
        {timelineBelow}
      </main>
      {inspector && <InspectorDivider />}
      {inspector}
    </div>
  );
}

/** The visual gap a Divider replaces where no resizable boundary exists. */
function Gap() {
  return <div className="w-[5px] shrink-0" />;
}


