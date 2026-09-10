/**
 * Tool-result elision (Track 2, L4b — see docs/AGENTIC_ROADMAP.md).
 *
 * The cheapest context discipline, and the one the research puts first: keep
 * the last N tool observations verbatim and replace older ones with a short
 * placeholder. It touches only the *content* of a result — never the number of
 * messages, their order, or the tool_use ids they answer — so the Anthropic
 * API's history invariants (one result per tool_use, alternating roles) are
 * untouched by construction.
 *
 * Two deliberate exceptions:
 * - error results are kept: they are short, and a model that forgets its own
 *   failed calls repeats them;
 * - an already-elided result is never re-wrapped, so repeated passes are
 *   idempotent.
 *
 * The stored history keeps full fidelity; only the outgoing request is elided.
 */

export const TOOL_RESULT_KEEP_LAST = 6;

const ELISION_PREFIX = '[earlier tool result elided to save context';
const ELISION_SUFFIX = ' — call the tool again if you need it.]';

interface ToolResultBlock {
  type?: unknown;
  content?: unknown;
  is_error?: unknown;
}

interface HistoryEntry {
  role?: unknown;
  content?: unknown;
}

export function elisionPlaceholder(): string {
  return `${ELISION_PREFIX}${ELISION_SUFFIX}`;
}

export function isElidedToolResult(content: unknown): boolean {
  return typeof content === 'string' && content.startsWith(ELISION_PREFIX);
}

/**
 * Return a copy of `entries` whose older tool-result contents are replaced by
 * the elision placeholder. Untouched entries keep their identity; when there
 * is nothing to elide the original array is returned unchanged.
 */
export function elideToolResults<T extends HistoryEntry>(
  entries: T[],
  keepLast: number = TOOL_RESULT_KEEP_LAST,
): T[] {
  const keep = Math.max(0, keepLast);

  // Collect every elidable block across the whole history, in order, so the
  // retention window is "the last N results", not "the last N per turn".
  const targets: ToolResultBlock[] = [];
  for (const entry of entries) {
    if (!Array.isArray(entry.content)) continue;
    for (const block of entry.content as ToolResultBlock[]) {
      if (block?.type !== 'tool_result') continue;
      if (block.is_error === true) continue;
      if (isElidedToolResult(block.content)) continue;
      targets.push(block);
    }
  }

  const elideCount = targets.length - keep;
  // Nothing to elide: hand back the caller's own array, so a no-op pass costs
  // nothing and the SDK still receives exactly the array it was given.
  if (elideCount <= 0) return entries;
  const elidedBlocks = new Set(targets.slice(0, elideCount));
  const placeholder = elisionPlaceholder();

  return entries.map((entry) => {
    if (!Array.isArray(entry.content)) return entry;
    let changed = false;
    const content = (entry.content as ToolResultBlock[]).map((block) => {
      if (!elidedBlocks.has(block)) return block;
      changed = true;
      // Replace the value, not the block: the tool_use_id and every other
      // field stay exactly as the API expects.
      return { ...block, content: placeholder };
    });
    return changed ? { ...entry, content } : entry;
  });
}
