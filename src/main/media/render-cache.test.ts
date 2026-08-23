import { describe, it, expect } from 'vitest';
import { ByteBudgetLru } from './render-cache';

describe('ByteBudgetLru', () => {
  it('stores and retrieves by key', () => {
    const lru = new ByteBudgetLru<string>(100);
    lru.set('a', 'A', 10);
    expect(lru.get('a')).toBe('A');
  });

  it('evicts least-recently-used when over budget', () => {
    const lru = new ByteBudgetLru<string>(30);
    lru.set('a', 'A', 10);
    lru.set('b', 'B', 10);
    lru.get('a'); // refresh a
    lru.set('c', 'C', 15); // must evict b (LRU), not a
    expect(lru.get('b')).toBeUndefined();
    expect(lru.get('a')).toBe('A');
    expect(lru.get('c')).toBe('C');
    expect(lru.usedBytes).toBe(25);
  });

  it('refuses an item larger than the whole budget without flushing', () => {
    const lru = new ByteBudgetLru<string>(20);
    lru.set('a', 'A', 10);
    lru.set('huge', 'H', 50);
    expect(lru.get('huge')).toBeUndefined();
    expect(lru.get('a')).toBe('A'); // untouched
    expect(lru.usedBytes).toBe(10);
  });

  it('updates bytes when a key is overwritten', () => {
    const lru = new ByteBudgetLru<string>(25);
    lru.set('a', 'A1', 20);
    lru.set('a', 'A2', 5);
    expect(lru.usedBytes).toBe(5);
    expect(lru.get('a')).toBe('A2');
  });

  it('clear resets everything', () => {
    const lru = new ByteBudgetLru<string>(50);
    lru.set('a', 'A', 10);
    lru.clear();
    expect(lru.size).toBe(0);
    expect(lru.usedBytes).toBe(0);
  });
});
