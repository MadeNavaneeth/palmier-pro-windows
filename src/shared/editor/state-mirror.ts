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

export class StateMirror {
  /** Last snapshot the peer confirmed. Empty until the first success. */
  private confirmed: string | null = null;
  private inFlight = false;

  /** True when this snapshot differs from what the peer confirmed. */
  needsPush(serialized: string): boolean {
    return serialized !== this.confirmed;
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
   * Rejections are returned rather than thrown: the caller is a detached
   * subscriber with nowhere to propagate them, and swallowing them silently is
   * the failure mode this type exists to prevent.
   */
  async push(serialized: string, send: SendSnapshot): Promise<MirrorPushResult> {
    if (!this.needsPush(serialized)) return { attempted: false, delivered: false };

    this.inFlight = true;
    try {
      await send(serialized);
      this.confirmed = serialized;
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
    this.confirmed = serialized;
  }

  /** True when this snapshot is our own state coming back from the peer. */
  isEcho(serialized: string): boolean {
    return this.confirmed !== null && serialized === this.confirmed;
  }

  /** Forget the peer's state, so the next push is unconditional. */
  reset(): void {
    this.confirmed = null;
  }
}
