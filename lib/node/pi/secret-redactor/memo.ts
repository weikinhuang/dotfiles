/**
 * A small LRU memo keyed by string, used by the `secret-redactor`
 * extension to cache `redactText` results across the whole transcript.
 * The `context` hook fires every request over every message, and
 * redaction is deterministic, so unchanged history re-scans for free.
 *
 * Pure - no pi imports - so the eviction + recency behaviour is
 * unit-tested directly. The cache is cleared whenever config or approvals
 * change (which is why the extension holds a `clear()`).
 *
 * Recency is tracked by `Map` insertion order: a hit is deleted and
 * re-inserted so it becomes most-recent, and eviction drops the oldest
 * key once `size` exceeds `cap`.
 */

/** A memo that computes-and-caches values keyed by string, evicting LRU. */
export interface LruMemo<V> {
  /** Return the cached value for `key`, computing (and caching) it on a miss. */
  get(key: string): V;
  /** Drop every cached entry. */
  clear(): void;
  /** Number of entries currently cached. */
  readonly size: number;
}

/**
 * Build an LRU memo of at most `cap` entries. On a miss, `compute(key)`
 * produces the value; on overflow the least-recently-used key is evicted.
 */
export function createLruMemo<V>(cap: number, compute: (key: string) => V): LruMemo<V> {
  const store = new Map<string, V>();
  return {
    get(key: string): V {
      const hit = store.get(key);
      if (hit !== undefined) {
        store.delete(key);
        store.set(key, hit);
        return hit;
      }
      const value = compute(key);
      store.set(key, value);
      if (store.size > cap) {
        const oldest = store.keys().next().value;
        if (oldest !== undefined) store.delete(oldest);
      }
      return value;
    },
    clear(): void {
      store.clear();
    },
    get size(): number {
      return store.size;
    },
  };
}
