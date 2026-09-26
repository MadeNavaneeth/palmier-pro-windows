/**
 * DroppedSyncNotice — an agent change this window refused to apply, on screen.
 *
 * The app can lose an edit to itself: `useEditorSync` discards an inbound push
 * that lands while a local write is outstanding, and main has already reported
 * that push landed. The agent's turn therefore completes with its transcript
 * reading as a success while the edit is in neither the window nor the session.
 * Sequencing the two instead of dropping one is a separate, larger decision that
 * is deliberately still open; until it is made, the loss has to be visible, and
 * this is the one place it is.
 *
 * It reuses the app's existing amber notice treatment rather than introducing a
 * new one — the same classes as `MediaBin`'s omission box, and mounted exactly
 * the way `RecoveryPrompt` mounts its own app-level notice: `fixed`, so it
 * overlays and pushes nothing, with `max-w` so it cannot outgrow a narrow
 * window, and `role="status"` so a screen reader hears it without stealing
 * focus.
 *
 * It is mounted at App level, beside `RecoveryPrompt`, and that placement is the
 * point rather than an accident. The obvious home for a notice is the media
 * panel's notice channel, which is where every other one-line status goes — but
 * that panel can be toggled off, moved into its own OS window (#286), or left on
 * an unselected tab, and the rendered probe measured this notice at 0x0 in the
 * tabbed layout for exactly that reason. A warning about lost work that the user
 * cannot see is the same as no warning, so this reads the conflict record
 * directly instead of borrowing a channel that can be hidden or overwritten.
 */

import { useProjectStore, type DroppedSyncConflict } from '../store/project';

/**
 * The one line the user reads about a refused inbound push, or null when there
 * is nothing to say.
 *
 * Three things it must not do, because each is a lie the user acts on: call this
 * a sync failure (nothing failed to deliver — main's push arrived and was
 * refused on purpose), imply the agent's work is recoverable here (it is
 * discarded, and only the agent can produce it again), or stay quiet about a
 * lost edit. So it names what was lost, names the cause, and points at the one
 * recovery that exists.
 *
 * A dropped `playhead` returns null. A cursor is not work: nothing the user
 * authored is missing, main still holds the edit that moved it, and the next
 * push re-establishes where it went. Warning about it would spend the warning
 * on nothing, which is how warnings stop being read.
 *
 * Split from the component so it is testable without a DOM, matching
 * `recoveryNotice` in RecoveryPrompt and `silenceRemovalStatus` in Inspector.
 */
export function droppedSyncNotice(conflict: DroppedSyncConflict): string | null {
  if (conflict.kind === 'playhead') return null;
  return conflict.dropped === 1
    ? 'An agent change was not applied — you were editing when it arrived, so it '
      + 'was discarded. Ask the agent to try again.'
    : `${conflict.dropped} agent changes were not applied — you were editing when `
      + 'they arrived, so they were discarded. Ask the agent to try again.';
}

export function DroppedSyncNotice() {
  const conflict = useProjectStore((state) => state.droppedSync);
  const clearDroppedSync = useProjectStore((state) => state.clearDroppedSync);
  if (!conflict) return null;
  const notice = droppedSyncNotice(conflict);
  if (!notice) return null;
  return (
    // The live region is the container, not the button, so the button keeps its
    // own semantics: `role="status"` on the button itself would replace them and
    // leave a screen-reader user with something announced but not activatable.
    <div
      role="status"
      className="pointer-events-none fixed bottom-4 right-4 z-50 w-[380px] max-w-[calc(100vw-2rem)]"
    >
      <button
        type="button"
        data-dropped-sync-notice
        onClick={clearDroppedSync}
        title="Click to dismiss"
        className="pointer-events-auto block w-full rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-left text-[10px] leading-relaxed text-amber-300 hover:bg-amber-500/20"
      >
        {notice}
      </button>
    </div>
  );
}
