/**
 * A byte-budget LRU for composited preview frames (roadmap R2 render cache).
 *
 * Frames are big (1080p RGBA ≈ 8 MB), so the cache is bounded by BYTES, not
 * entry count: inserting past the budget evicts least-recently-used entries
 * until it fits, and an item larger than the entire budget is refused rather
 * than flushing everything else.
 */

export class ByteBudgetLru<V> {
  private map = new Map<string, { value: V; bytes: number }>();
  private used = 0;

  constructor(readonly maxBytes: number) {
    if (!(maxBytes > 0)) throw new Error('ByteBudgetLru requires a positive budget');
  }

  get size(): number {
    return this.map.size;
  }

  get usedBytes(): number {
    return this.used;
  }

  /** Refresh recency and return the value, or undefined. */
  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    // Re-insert to move to the end of the Map's insertion order (MRU).
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key: string, value: V, bytes: number): void {
    if (bytes > this.maxBytes) return;
    const previous = this.map.get(key);
    if (previous) {
      this.used -= previous.bytes;
      this.map.delete(key);
    }
    while (this.used + bytes > this.maxBytes && this.map.size > 0) {
      const oldest = this.map.keys().next().value as string;
      const evicted = this.map.get(oldest)!;
      this.used -= evicted.bytes;
      this.map.delete(oldest);
    }
    this.map.set(key, { value, bytes });
    this.used += bytes;
  }

  clear(): void {
    this.map.clear();
    this.used = 0;
  }
}
