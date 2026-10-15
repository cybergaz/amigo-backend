// =============================================================================
// Per-key epoch guard for bus-invalidated LRUs (SYNC_V2 §13.7 E1–E3)
// =============================================================================
// The conv / user-peer / fcm-token LRUs are per-process copies of Redis data,
// kept honest by pub/sub invalidations. One race survives a delete-on-
// invalidate: a read misses, goes to Redis / Postgres (milliseconds, more on
// a slow RDS), and an invalidation for that key arrives WHILE it is out. The
// delete finds nothing, the read then fills the LRU with the value it loaded
// BEFORE the change, and that stale value is served for the whole TTL (a
// removed member keeps receiving the group's messages; a logged-out device
// keeps getting the previous owner's pushes).
//
// The guard: a read takes `snapshot()` before it starts, and may fill the
// LRU only if no invalidation of that key (or of everything) happened since.
// A refused fill costs one extra miss later, never correctness.
//
// Memory is bounded: past `max_keys` remembered invalidations the map is
// dropped and a floor is raised instead, which refuses every fill started
// before it (the same as a bus resync).

class EpochGuard {
  private seq = 0;
  private floor = 0;
  private readonly last = new Map<string, number>();

  constructor(private readonly max_keys = 10_000) {}

  /** Take before reading the lower tiers. */
  snapshot(): number {
    return this.seq;
  }

  /** An invalidation of `key` (local write or bus message). */
  bump(key: string): void {
    this.seq++;
    this.last.set(key, this.seq);
    if (this.last.size > this.max_keys) {
      this.floor = this.seq;
      this.last.clear();
    }
  }

  /** Everything is suspect (bus resync: invalidations may have been lost). */
  bump_all(): void {
    this.seq++;
    this.floor = this.seq;
    this.last.clear();
  }

  /** May a read that started at `snap` fill the cache for `key`? */
  may_set(key: string, snap: number): boolean {
    if (snap < this.floor) return false;
    const l = this.last.get(key);
    return l === undefined || l <= snap;
  }

  size(): number {
    return this.last.size;
  }
}

export { EpochGuard };
