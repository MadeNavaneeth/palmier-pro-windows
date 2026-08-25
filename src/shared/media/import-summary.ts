/**
 * Full skip summary for a media import (upstream issue #453).
 *
 * Both import surfaces used to show only `errors[0]`, so dropping several
 * unsupported files named one of them and hid the rest. Every skipped item
 * now arrives with its own reason; this keeps the banner readable by listing
 * the first few and counting the remainder.
 */

const MAX_LISTED_ERRORS = 3;

export function formatImportErrors(errors: readonly string[] | undefined): string {
  if (!errors || errors.length === 0) return '';
  const listed = errors.slice(0, MAX_LISTED_ERRORS).join(' · ');
  const remaining = errors.length - MAX_LISTED_ERRORS;
  return remaining > 0 ? `${listed} (+${remaining} more)` : listed;
}
