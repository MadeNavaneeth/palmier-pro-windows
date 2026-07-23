import React, { useEffect, useState } from 'react';
import { TitleBar } from './components/TitleBar';
import { MediaBin } from './components/MediaBin';
import { Timeline } from './components/Timeline';
import { Preview } from './components/Preview';
import { WelcomeScreen } from './components/WelcomeScreen';
import { ChatPanel, SettingsPanel } from './components/ai';
import { Inspector } from './components/Inspector';
import { ExportDialog } from './components/ExportDialog';
import { useProjectStore } from './store/project';
import { initAiListeners } from './store/ai';
import { useAutosave } from './hooks/useAutosave';
import { useEditorSync } from './hooks/useEditorSync';

export function App() {
  const { isLoaded } = useProjectStore();
  const [systemReady, setSystemReady] = useState(false);
  const [mediaVisible, setMediaVisible] = useState(true);
  const [inspectorVisible, setInspectorVisible] = useState(true);
  const [agentVisible, setAgentVisible] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

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
    init();

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
      <>
        <TitleBar />
        <WelcomeScreen />
      </>
    );
  }

  return (
    <div className="flex h-screen w-screen flex-col bg-surface-0">
      <TitleBar
        mediaVisible={mediaVisible}
        inspectorVisible={inspectorVisible}
        agentVisible={agentVisible}
        onToggleMedia={() => setMediaVisible((value) => !value)}
        onToggleInspector={() => setInspectorVisible((value) => !value)}
        onToggleAgent={() => setAgentVisible((value) => !value)}
        onExport={() => setExportOpen(true)}
      />
      <div className="flex min-h-0 flex-1 gap-[5px] overflow-hidden p-[5px] pt-0">
        {agentVisible && (
          <aside className="flex w-[300px] shrink-0 flex-col overflow-hidden bg-surface-1">
            <ChatPanel />
          </aside>
        )}

        {mediaVisible && (
          <aside className="flex w-[clamp(280px,30vw,500px)] shrink-0 flex-col overflow-hidden bg-surface-1">
          <MediaBin />
          </aside>
        )}

        <main className="flex min-h-0 min-w-[400px] flex-1 flex-col gap-[5px]">
          <Preview />
          <Timeline />
        </main>

        {inspectorVisible && (
          <aside className="flex w-[clamp(240px,20vw,340px)] shrink-0 flex-col overflow-hidden bg-surface-1">
            <Inspector />
          </aside>
        )}
      </div>

      <SettingsPanel />
      <ExportDialog isOpen={exportOpen} onClose={() => setExportOpen(false)} />
    </div>
  );
}
