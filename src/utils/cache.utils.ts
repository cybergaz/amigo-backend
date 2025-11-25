interface CacheEntry<V> {
  value: V;
  expires_at: number;
  last_accessed: number;
}

class LRUCache<K, V> {
  private cache: Map<K, CacheEntry<V>>;
  private capacity: number;
  private ttl: number; // milliseconds

  constructor(capacity: number = 1000, ttl: number = 5 * 60 * 1000) {
    if (capacity <= 0) throw new Error("Capacity must be greater than 0");
    if (ttl <= 0) throw new Error("TTL must be greater than 0");

    this.capacity = capacity;
    this.ttl = ttl;
    this.cache = new Map();
  }

  // Check if entry is expired
  private isExpired(entry: CacheEntry<V>): boolean {
    return Date.now() > entry.expires_at;
  }

  // Get value from cache
  get(key: K): V | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (this.isExpired(entry)) {
      this.cache.delete(key);
      return null;
    }

    // Update last accessed time
    entry.last_accessed = Date.now();

    // Refresh position (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.value;
  }

  // Set value in cache with optional TTL
  set(key: K, value: V, ttl?: number): void {
    const now = Date.now();
    const expires_at = now + (ttl || this.ttl);

    // Update existing key if present
    if (this.cache.has(key)) {
      const entry = this.cache.get(key)!;
      entry.value = value;
      entry.expires_at = expires_at;
      entry.last_accessed = now;

      // Refresh position
      this.cache.delete(key);
      this.cache.set(key, entry);
      return;
    }

    // If cache is full, remove least recently used
    else if (this.cache.size >= this.capacity) {
      const lruKey = this.cache.keys().next().value;
      if (lruKey) this.cache.delete(lruKey);
    }

    this.cache.set(key, {
      value,
      expires_at,
      last_accessed: now,
    });
  }

  // Check if key exists and is not expired
  has(key: K): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;

    if (this.isExpired(entry)) {
      this.cache.delete(key);
      return false;
    }

    return true;
  }

  // Delete value from cache
  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  // Get current size of cache
  size(): number {
    return this.cache.size;
  }

  // Clear the cache
  clear(): void {
    this.cache.clear();
  }

  // Get all keys in cache
  keys(): K[] {
    // Clean expired ones before returning
    for (const [key, entry] of this.cache) {
      if (this.isExpired(entry)) this.cache.delete(key);
    }
    return Array.from(this.cache.keys());
  }

  // clean expired entries
  clean_expired(): number {
    let cleaned = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (this.isExpired(entry)) {
        this.cache.delete(key);
        cleaned++;
      }
    }

    return cleaned;
  }
}

export default LRUCache;
