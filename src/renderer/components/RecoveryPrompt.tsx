/**
 * RecoveryPrompt — the explicit first-run decision for a crash snapshot.
 *
 * This follows the existing modal-dialog convention used by ShortcutHelpDialog
 * and CommandPalette. It deliberately has no backdrop-dismiss action: Restore
 * and Discard are both meaningful, irreversible choices for the user.
 */

import React from 'react';
import { useRecovery } from '../hooks/useRecovery';

export function RecoveryPrompt() {
  const { candidate, busy, error, restore, discard } = useRecovery();
  if (!candidate) return null;

  return (
    <div
      data-recovery-prompt
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="recovery-prompt-title"
        className="w-[420px] rounded-lg border border-surface-3 bg-surface-1 p-5 shadow-2xl"
      >
        <p className="text-[10px] uppercase tracking-wide text-amber-300">
          Unsaved work found
        </p>
        <h2 id="recovery-prompt-title" className="mt-1 text-sm font-medium text-text-primary">
          Recover this project?
        </h2>
        <p className="mt-2 text-xs leading-5 text-text-secondary">
          Palmier found a crash-recovery snapshot. It may contain edits that are not
          in the last saved project. Restore it to continue from the snapshot, or
          discard it to start from the current project.
        </p>
        <p className="mt-3 truncate text-[10px] text-text-muted">
          {candidate.snapshot.projectName || 'Untitled Project'} ·{' '}
          {new Date(candidate.snapshot.savedAt).toLocaleString()}
        </p>
        {error && <p role="alert" className="mt-3 text-[10px] text-red-300">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => { void discard(); }}
            className="rounded border border-surface-3 px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-2 disabled:opacity-50"
          >
            Discard
          </button>
          <button
            type="button"
            autoFocus
            disabled={busy}
            onClick={() => { void restore(); }}
            className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-surface-0 hover:bg-accent-hover disabled:opacity-50"
          >
            Restore
          </button>
        </div>
      </div>
    </div>
  );
}
