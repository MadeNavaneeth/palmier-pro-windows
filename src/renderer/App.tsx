import React, { useEffect, useState } from 'react';
import { TitleBar } from './components/TitleBar';
import { MediaBin } from './components/MediaBin';
import { Timeline } from './components/Timeline';
import { Preview } from './components/Preview';
import { WelcomeScreen } from './components/WelcomeScreen';
import { ChatPanel, SettingsPanel } from './components/ai';
import { Inspector } from './components/Inspector';
import { useProjectStore } from './store/project';
import { initAiListeners } from './store/ai';
import { useAutosave } from './hooks/useAutosave';
import { useEditorSync } from './hooks/useEditorSync';

export function App() {
  const { isLoaded } = useProjectStore();
  const [systemReady, setSystemReady] = useState(false);

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
      <TitleBar />
      <div className="flex flex-1 overflow-hidden">
        {/* Left panel: Media Bin */}
        <aside className="flex w-72 flex-col border-r border-surface-3 bg-surface-1">
          <MediaBin />
        </aside>

        {/* Center: Preview + Timeline */}
        <main className="flex flex-1 flex-col">
          <Preview />
          <Timeline />
        </main>

        {/* Right panel: Inspector + AI Chat */}
        <aside className="flex w-80 flex-col border-l border-surface-3 bg-surface-1">
          <Inspector />
          <ChatPanel />
        </aside>
      </div>

      {/* Modals */}
      <SettingsPanel />
    </div>
  );
}
