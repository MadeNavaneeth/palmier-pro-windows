import { describe, expect, it } from 'vitest';
import { recoveryNotice } from './RecoveryPrompt';

/**
 * `restoreRecoverySnapshot` applies the project before it persists a copy of it,
 * so a persist failure leaves an applied project, a non-null error, and no
 * candidate for the modal to hang that error on. These tests pin that the
 * notice appears in exactly that case and nowhere else -- the modal keeps
 * rendering its own `role="alert"` when a candidate is still present.
 */
describe('recoveryNotice', () => {
  const RESTORED_NOT_SAVED =
    'The project was restored, but saving a copy of it failed; the original snapshot was kept.';

  it('shows the hook wording when the restore applied but the persist failed', () => {
    expect(recoveryNotice(false, RESTORED_NOT_SAVED)).toBe(RESTORED_NOT_SAVED);
  });

  it('defers to the modal while a candidate is still present', () => {
    // The modal renders its own role="alert" for this case; showing it twice
    // would be wrong.
    expect(recoveryNotice(true, 'The recovery snapshot could not be opened.')).toBeNull();
  });

  it('stays hidden when there is nothing to say', () => {
    expect(recoveryNotice(false, null)).toBeNull();
    expect(recoveryNotice(true, null)).toBeNull();
  });

  it('does not invent wording of its own', () => {
    // The helper decides *whether* to show, never *what* -- the hook owns the
    // wording per outcome, so a copy here would drift.
    const message = 'Any message at all.';
    expect(recoveryNotice(false, message)).toBe(message);
  });
});
