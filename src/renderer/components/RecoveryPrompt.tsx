/**
 * RecoveryPrompt — the explicit first-run decision for a crash snapshot.
 *
 * This follows the existing modal-dialog convention used by ShortcutHelpDialog
 * and CommandPalette. It deliberately has no backdrop-dismiss action: Restore
 * and Discard are both meaningful, irreversible choices for the user.
 */

import React from 'react';
import { useRecovery } from '../hooks/useRecovery';

/**
 * A notice for the case where there is no candidate left to attach an error to.
 *
 * `restoreRecoverySnapshot` applies the project before it persists a copy of
 * it, so a persist failure leaves an applied project and a non-null error with
 * no modal left to render it in. Returning null unconditionally showed the user
 * a loaded project and said nothing about it; the hook already words each outcome
 * accurately, so the only thing missing was somewhere to put it.
 *
 * Split from the component so it is testable without a DOM, matching the
 * convention used by `summarizeXmlOmissions`, `silenceRemovalStatus` and
 * `hasCaptionTitles`.
 */
export function recoveryNotice(hasCandidate: boolean, error: string | null): string | null {
  if (hasCandidate || !error) return null;
  return error;
}

export function RecoveryPrompt() {
  const { candidate, busy, error, restore, discard } = useRecovery();
  const notice = recoveryNotice(candidate !== null, error);
  if (!candidate) {
    if (!notice) return null;
    return (
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 w-[380px] max-w-[calc(100vw-2rem)]">
        <div
          data-recovery-notice
          role="status"
          className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[10px] leading-relaxed text-amber-300"
        >
          {notice}
        </div>
      </div>
    );
  }

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
