/**
 * Track name validation (upstream PR #520).
 *
 * A user-assigned name is persistent; the generated `Video 1` / `Audio 2`
 * style label remains the fallback when the user clears the field. The rules
 * mirror upstream's `TrackName.normalized`: trim surrounding whitespace,
 * refuse control characters and line breaks, cap the length, and treat an
 * empty result as "restore the generated label".
 */

export const TRACK_NAME_MAX_LENGTH = 80;

/**
 * Resolve a raw user-entered track name.
 *
 * Returns the trimmed name to store, or `null` when the input is invalid
 * (control characters, newlines, or over the length cap) and must not be
 * committed. An empty-after-trim input resolves to `generatedDefault`, which
 * is how clearing the field restores the automatic label.
 */
export function resolveTrackName(raw: string, generatedDefault: string): string | null {
  const name = raw.trim();
  if (name.length === 0) return generatedDefault;
  if (name.length > TRACK_NAME_MAX_LENGTH) return null;
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return null;
  }
  return name;
}
