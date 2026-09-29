/**
 * The panel's handling of a failed `export:reveal`.
 *
 * `export:reveal` used to answer `{ success: true }` for every path, and the
 * panel called it as `void window.palmier.export.reveal(...)`, so a reveal that
 * never happened left nothing to report. Awaiting the answer is only half the
 * fix: the message has to reach the panel's existing `error` channel, which is
 * what `revealFailureMessage` decides.
 *
 * Tested at this level because the panel itself renders through
 * `renderToStaticMarkup` in a node environment — there is no DOM and no event
 * dispatch, so the click -> setError -> re-render path is unreachable from a
 * test. The decision it makes is the part that decides visibility.
 */
import { describe, expect, it } from 'vitest';
import { revealFailureMessage } from './ExportDialog';

describe('reveal failure in the export panel', () => {
  it('shows the error main reported instead of a bare success', () => {
    expect(revealFailureMessage({ success: false, error: 'File not found' }))
      .toBe('File not found');
  });

  it('says nothing when the reveal succeeded', () => {
    expect(revealFailureMessage({ success: true })).toBeNull();
  });

  it('falls back to its own wording when main reported no reason', () => {
    // The handler answers success for a non-path without calling the shell, so
    // a falsy answer is not by itself a failure — only `success: false` is.
    expect(revealFailureMessage({ success: true })).toBeNull();
    expect(revealFailureMessage({ success: false })).toBe('Could not reveal the file in Explorer.');
  });

  it('treats a missing answer as a failure rather than a success', () => {
    expect(revealFailureMessage(undefined)).toBe('Could not reveal the file in Explorer.');
  });
});
