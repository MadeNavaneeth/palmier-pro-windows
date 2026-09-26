/**
 * StateMirror — tracks what a peer process has actually accepted.
 *
 * The renderer owns the authoritative project and mirrors it to the main-process
 * controller, which the Agent and MCP server read. Deduplicating those pushes is
 * necessary (a project mutation fires on every drag frame), but the original
 * implementation recorded the snapshot as "pushed" before the IPC call resolved.
 * One transient failure then left main holding a stale project while the
 * renderer believed it was mirrored, and because the dedupe check matched, the
 * same snapshot was never retried — so tools acted on a stale timeline until the
 * project happened to change to something different.
 *
 * The rule this type enforces: a snapshot counts as mirrored only after the peer
 * confirms it (upstream issue #89).
 *
 * Snapshots are compared by VALUE, not by spelling. `EditorController.serialize`
 * pretty-prints while every peer payload is compact (`JSON.stringify(project)`),
 * so raw string equality never matched across that boundary and both the dedupe
 * check and the echo guard were dead code. `serialize()`'s own output is left
 * alone — other consumers read it — and canonicalization happens here, on the
 * comparison side.
 */

export type SendSnapshot = (serialized: string) => Promise<unknown>;

export interface MirrorPushResult {
  /** False when the snapshot matched what the peer already has. */
  attempted: boolean;
  /** True when the peer accepted it. */
  delivered: boolean;
  /** Rejection reason, when the send failed. */
  error?: unknown;
}

/** One JSON value, one spelling: sorted keys, no insignificant whitespace. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(',')}}`;
}

/**
 * Comparable form of a snapshot, or null when it is not JSON.
 *
 * A snapshot that cannot be parsed is compared verbatim instead of throwing:
 * it is a string the peer sent us, and the caller's contract is a boolean.
 */
function canonicalSnapshot(serialized: string): string | null {
  try {
    return stableStringify(JSON.parse(serialized));
  } catch {
    return null;
  }
}

export class StateMirror {
  /** Last snapshot the peer confirmed, in the spelling it arrived in. */
  private confirmed: string | null = null;
  /** The same snapshot in comparable form, so a peer's spelling never differs. */
  private confirmedCanonical: string | null = null;
  private inFlight = false;

  /** True when this snapshot differs from what the peer confirmed. */
  needsPush(serialized: string): boolean {
    return !this.matches(serialized);
  }

  /** The snapshot the peer is known to hold, or null before the first success. */
  lastConfirmed(): string | null {
    return this.confirmed;
  }

  /** True while a push is awaiting confirmation. */
  isPushing(): boolean {
    return this.inFlight;
  }

  /**
   * Push a snapshot, recording it only if the peer accepts it.
   *
   * Rejections and resolved refusal replies are returned rather than thrown:
   * the caller is a detached subscriber with nowhere to propagate them, and
   * swallowing them silently is the failure mode this type exists to prevent.
   */
  async push(serialized: string, send: SendSnapshot): Promise<MirrorPushResult> {
    if (!this.needsPush(serialized)) return { attempted: false, delivered: false };

    this.inFlight = true;
    try {
      const response = await send(serialized);
      // IPC handlers commonly report a refusal by resolving with this shape
      // rather than rejecting. It is still an unsuccessful delivery.
      if (
        typeof response === 'object'
        && response !== null
        && (response as { success?: unknown }).success === false
      ) {
        const error = (response as { error?: unknown }).error;
        return { attempted: true, delivered: false, error: error ?? response };
      }
      this.record(serialized);
      return { attempted: true, delivered: true };
    } catch (error) {
      // Deliberately not recorded: leaving `confirmed` alone is what allows the
      // next edit to retry this state.
      return { attempted: true, delivered: false, error };
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Record a snapshot the peer already has without sending it.
   *
   * Used when the peer pushes state to us: it demonstrably holds that state, so
   * echoing it back is redundant.
   */
  markConfirmed(serialized: string): void {
    this.record(serialized);
  }

  /** True when this snapshot is our own state coming back from the peer. */
  isEcho(serialized: string): boolean {
    return this.matches(serialized);
  }

  /** Forget the peer's state, so the next push is unconditional. */
  reset(): void {
    this.confirmed = null;
    this.confirmedCanonical = null;
  }

  private record(serialized: string): void {
    this.confirmed = serialized;
    this.confirmedCanonical = canonicalSnapshot(serialized);
  }

  /**
   * Whether the peer is known to hold this exact JSON value.
   *
   * The raw spellings are compared first: a project is serialized and
   * re-serialized constantly, and equal strings are by far the common case, so
   * this keeps the dedupe off the parse path. Only a differing spelling pays
   * for canonicalization, which is what makes a pretty snapshot and a compact
   * payload from the same project compare equal.
   */
  private matches(serialized: string): boolean {
    if (this.confirmed === null) return false;
    if (serialized === this.confirmed) return true;
    const canonical = canonicalSnapshot(serialized);
    // One side is unparseable: fall back to the raw comparison so a non-JSON
    // snapshot is still deduplicated against the identical string.
    if (canonical === null || this.confirmedCanonical === null) return false;
    return canonical === this.confirmedCanonical;
  }
}
