import React from 'react';
import { useProjectStore } from '../store/project';

export function WelcomeScreen() {
  const { createNew, openExisting } = useProjectStore();

  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center bg-surface-0">
      <div className="flex flex-col items-center gap-8">
        {/* Logo area */}
        <div className="flex flex-col items-center gap-2">
          <h1 className="text-3xl font-light tracking-tight text-text-primary">
            Palmier Pro
          </h1>
          <p className="text-sm text-text-muted">
            AI-native video editor for Windows
          </p>
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-3 w-64">
          <button
            onClick={createNew}
            className="flex items-center justify-center gap-2 rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-white transition hover:bg-accent-hover"
          >
            New Project
          </button>
          <button
            onClick={openExisting}
            className="flex items-center justify-center gap-2 rounded-md border border-surface-4 bg-surface-2 px-4 py-2.5 text-sm font-medium text-text-primary transition hover:bg-surface-3"
          >
            Open Project
          </button>
        </div>

        {/* Recent projects (Phase 1+) */}
        <div className="mt-4 text-center">
          <p className="text-2xs text-text-muted">
            Recent projects will appear here
          </p>
        </div>

        {/* Attribution */}
        <p className="mt-8 text-2xs text-text-muted">
          A derivative of{' '}
          <span className="text-text-secondary">Palmier Pro</span> by Palmier, Inc. (GPL-3.0)
        </p>
      </div>
    </div>
  );
}
