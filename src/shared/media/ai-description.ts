/**
 * AI media descriptions (upstream #118, AI half).
 *
 * The zero-cost half (tags.ts) derives heuristic labels at display time and
 * persists nothing. This half is an on-demand, BYOK, vision-model-generated
 * sentence stored per asset as `MediaAsset.aiDescription` and matched by the
 * same search box. It is NEVER generated automatically — only an explicit
 * Describe action (media tile/panel button or the `describe_media` agent
 * tool) triggers a cloud call, and the text is sent to the user's own
 * configured provider only. Nothing is cached outside the project: the
 * description lives on the asset and round-trips through the .vproj file.
 */

export const AI_DESCRIPTION_MAX_LENGTH = 500;

/** Clean a raw model/user string into a storable description, or null. */
export function sanitizeAiDescription(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // Strip control characters (including newlines — a description is one line
  // for tile/tooltip/search display), collapse whitespace, trim.
  const cleaned = raw
    .replace(/[\u0000-\u0008\u000A-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, AI_DESCRIPTION_MAX_LENGTH)
    .trim();
  if (cleaned.length === 0) return null;
  return cleaned;
}

/**
 * Narrow an untrusted stored value on project load.
 *
 * Non-strings and over-long values degrade to absent (undefined) rather than
 * breaking the load; valid values come back sanitized. Over-long is judged
 * on the raw string so a hand-edited file cannot smuggle in a value our own
 * writes would never produce.
 */
export function narrowAiDescription(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.length === 0 || value.length > AI_DESCRIPTION_MAX_LENGTH) return undefined;
  const cleaned = sanitizeAiDescription(value);
  return cleaned ?? undefined;
}
