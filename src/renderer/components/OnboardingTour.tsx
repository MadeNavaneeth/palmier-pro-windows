/**
 * OnboardingTour — lightweight first-run guidance (upstream PRs #456/#458,
 * first slice without analytics or guided flow).
 *
 * Free, local, zero-cost: three brief steps that describe the actions available
 * on the welcome screen. Dismissed state lives in localStorage so the tour never
 * reappears unless the user clears storage — the same persisted-store contract
 * the workspace layout uses.
 */

import React, { useState } from 'react';

const STORAGE_KEY = 'palmier.onboarding.dismissed';
const STEPS = [
  { title: 'Welcome screen', body: 'Select Skip tour to return to the welcome screen, where you can choose New Project to start with an empty project or Open Project to open a saved project.' },
  { title: 'New Project', body: 'New Project starts a new, empty project.' },
  { title: 'Open Project', body: 'Open Project opens a saved project file.' },
] as const;

function isDismissed(): boolean {
  try {
    return window.localStorage?.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function dismiss(): void {
  try {
    window.localStorage?.setItem(STORAGE_KEY, '1');
  } catch { /* quota */ }
}

export function OnboardingTour() {
  const [index, setIndex] = useState(0);
  const [visible, setVisible] = useState(() => !isDismissed());
  if (!visible) return null;

  const step = STEPS[index];
  const last = index === STEPS.length - 1;

  const close = () => {
    dismiss();
    setVisible(false);
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div role="dialog" aria-modal="true" aria-label="Onboarding tour" className="w-[420px] rounded-lg border border-surface-3 bg-surface-1 p-5 shadow-2xl">
        <p className="text-[10px] uppercase tracking-wide text-text-muted">Step {index + 1} of {STEPS.length}</p>
        <h2 className="mt-1 text-sm font-medium text-text-primary">{step.title}</h2>
        <p className="mt-2 text-xs leading-5 text-text-secondary">{step.body}</p>
        <div className="mt-4 flex items-center justify-between">
          <button onClick={close} className="text-[11px] text-text-muted hover:text-text-secondary">Skip tour</button>
          <div className="flex items-center gap-2">
            {index > 0 && (
              <button onClick={() => setIndex((i) => i - 1)} className="rounded border border-surface-3 px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-2">Back</button>
            )}
            <button
              onClick={() => {
                if (last) close();
                else setIndex((i) => i + 1);
              }}
              className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-surface-0 hover:bg-accent-hover"
            >
              {last ? 'Done' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
