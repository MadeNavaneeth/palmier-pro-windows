import React, { useEffect, useState } from 'react';
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
import { useUiStore, type PanelVisibility } from './store/ui';
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
          console.warn('FFmpeg not found on PATH — media features will be limited.');
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
 * instead of scrolling — the rightmost panel simply left the window. Rendered
 * checks missed it because they measured document scrollbars and the two toolbar
 * rows, not the workspace row itself.
 *
 * So the panels shrink under pressure down to a stated floor, and nothing is
 * rigid except the Agent column, which is already at its minimum useful width.
 * At sizes where everything fits the preferred widths are unchanged.
 *
 * Wrapper columns need explicit floors rather than a content-derived minimum,
 * because they contain the timeline, whose min-content width is the full length
 * of the material.
 */
/** Narrowest a side panel is allowed to be squeezed to. */
const PANEL_FLOOR = 'min-w-[200px]';
const MEDIA_WIDTH = `w-[clamp(280px,30vw,500px)] ${PANEL_FLOOR}`;
const INSPECTOR_WIDTH = `w-[clamp(240px,20vw,340px)] ${PANEL_FLOOR}`;
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
/** Media floor + gap + inspector floor. */
const MEDIA_WITH_INSPECTOR_MIN = 'min-w-[405px]';

/**
 * The three arrangements from upstream PR #430.
 *
 * Expressed as nested flex rather than draggable splitters, which is the honest
 * shape of what exists today: the presets give the arrangements their value —
 * particularly `vertical`, where a tall preview column is what makes portrait
 * work practical — while resizable dividers remain a separate gap.
 *
 * `min-h-0` and `min-w-0` appear throughout on purpose. A flex child defaults to
 * its content's minimum size, so without them the timeline's scrollable content
 * pushes the whole column wider than the window instead of scrolling.
 */
function WorkspacePresetLayout({
  layout,
  panels,
}: {
  layout: LayoutPreset;
  panels: PanelVisibility;
}) {
  const media = panels.media ? (
    <aside className={`${PANEL_FRAME} min-h-0 ${MEDIA_WIDTH}`}>
      <MediaBin />
    </aside>
  ) : null;

  const inspector = panels.inspector ? (
    <aside className={`${PANEL_FRAME} min-h-0 ${INSPECTOR_WIDTH}`}>
      <Inspector />
    </aside>
  ) : null;

  const hasSidePanel = media !== null || inspector !== null;

  if (layout === 'media') {
    // [Media] | [Preview | Inspector] / [Timeline]
    // Media runs the full height, which is what makes sifting through a large
    // bin bearable.
    return (
      <div className="flex min-h-0 min-w-0 flex-1 gap-[5px]">
        {media}
        <div
          className={`flex min-h-0 flex-1 flex-col gap-[5px] ${
            inspector ? PREVIEW_WITH_INSPECTOR_MIN : PREVIEW_MIN
          }`}
        >
          <div className="flex min-h-0 flex-1 gap-[5px]">
            <main className={`flex min-h-0 flex-1 flex-col ${PREVIEW_MIN}`}>
              <Preview />
            </main>
            {inspector}
          </div>
          <Timeline />
        </div>
      </div>
    );
  }

  if (layout === 'vertical') {
    // [Media | Inspector] / [Timeline] | [Preview]
    // The preview takes a tall right-hand column so a 9:16 frame is shown large
    // instead of being letterboxed into a wide box.
    return (
      <div className="flex min-h-0 min-w-0 flex-1 gap-[5px]">
        <div
          className={`flex min-h-0 flex-1 flex-col gap-[5px] ${
            media && inspector ? MEDIA_WITH_INSPECTOR_MIN : PANEL_FLOOR
          }`}
        >
          {hasSidePanel && (
            <div className="flex min-h-0 flex-1 gap-[5px]">
              {media}
              {inspector}
            </div>
          )}
          {/* Nothing else claims this column when both side panels are hidden, so
              the timeline takes the height instead of leaving it blank. */}
          <Timeline fill={!hasSidePanel} />
        </div>
        <main className={`flex min-h-0 w-[clamp(320px,38vw,720px)] flex-col ${PREVIEW_MIN}`}>
          <Preview />
        </main>
      </div>
    );
  }

  // Default: [Media | Preview | Inspector] / [Timeline]
  return (
    <div className="flex min-h-0 min-w-0 flex-1 gap-[5px]">
      {media}
      <main className={`flex min-h-0 flex-1 flex-col gap-[5px] ${PREVIEW_MIN}`}>
        <Preview />
        <Timeline />
      </main>
      {inspector}
    </div>
  );
}
