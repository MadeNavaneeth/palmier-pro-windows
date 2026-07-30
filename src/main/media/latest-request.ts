export interface RequestToken<K> {
  key: K;
  generation: number;
}

/**
 * Tracks the newest asynchronous request for each consumer.
 * Older work may finish, but it must not publish over newer results.
 */
export class LatestRequestGate<K> {
  private generation = 0;
  private readonly latest = new Map<K, number>();

  begin(key: K): RequestToken<K> {
    const token = { key, generation: ++this.generation };
    this.latest.set(key, token.generation);
    return token;
  }

  isCurrent(token: RequestToken<K>): boolean {
    return this.latest.get(token.key) === token.generation;
  }

  invalidateAll(): void {
    this.latest.clear();
  }
}
