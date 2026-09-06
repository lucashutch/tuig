export interface BoundedCacheOptions {
  /** Maximum number of live entries retained by the cache. */
  maxEntries: number;
  /** How long an entry remains readable, in milliseconds. */
  ttlMs: number;
  /** Clock used for expiry checks. Injected clocks make expiry deterministic. */
  now?: () => number;
}

type CacheEntry<V> = {
  value: V;
  expiresAt: number;
};

/**
 * A small insertion-ordered cache with lazy TTL expiry.
 *
 * Reads refresh recency, while expired entries are removed during normal cache
 * operations. No timer is needed, so an idle cache does not keep the process
 * alive or retain a separate cleanup task.
 */
export class BoundedCache<K, V> {
  private readonly entries = new Map<K, CacheEntry<V>>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: BoundedCacheOptions) {
    if (!Number.isSafeInteger(options.maxEntries) || options.maxEntries < 1)
      throw new RangeError("maxEntries must be a positive integer");
    if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0)
      throw new RangeError("ttlMs must be positive and finite");
    this.maxEntries = options.maxEntries;
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? (() => Date.now());
  }

  get(key: K): V | undefined {
    this.pruneExpiredAt(this.now());
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V): void {
    const now = this.now();
    this.pruneExpiredAt(now);
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: now + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  delete(key: K): boolean {
    this.pruneExpiredAt(this.now());
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  has(key: K): boolean {
    this.pruneExpiredAt(this.now());
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return true;
  }

  get size(): number {
    this.pruneExpiredAt(this.now());
    return this.entries.size;
  }

  /** Remove expired entries and return how many were removed. */
  pruneExpired(): number {
    return this.pruneExpiredAt(this.now());
  }

  private pruneExpiredAt(now: number): number {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /** Return keys from least recently used to most recently used. */
  keys(): IterableIterator<K> {
    this.pruneExpiredAt(this.now());
    return this.entries.keys();
  }
}
