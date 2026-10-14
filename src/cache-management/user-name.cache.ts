import db from "@/config/db";
import { user_model } from "@/models/user.model";
import LRUCache from "@/utils/cache.utils";
import { eq } from "drizzle-orm";

// =============================================================================
// user_id -> display name (SYNC_V2 §13.6.5 step 3, D-C4)
// =============================================================================
// The WS `open` used to get the user's name as a by-product of
// `update_user_details(user_id, { last_seen })` — an UPDATE ... RETURNING on
// every connect, so a reconnect herd (deploy, Wi-Fi blip across a building)
// became a burst of row-locking writes on RDS. The name is only needed as the
// sender name in pushes / call screens, so it now comes from this cache:
// reconnects hit the LRU, a miss costs one primary-key SELECT (no write, no
// lock). Staleness is bounded by the TTL and by set/invalidate below, called
// from the user-update paths.
//
// Per process (P-1 allows memory as a cache): at N>1 a rename seen on one
// worker reaches the others within the TTL; a slightly stale display name in a
// push title is acceptable.

const NAME_TTL_MS = 30 * 60 * 1000; // 30 min
const NAME_CAPACITY = 20_000; // ~3k daily users today; headroom for growth

const user_name_cache = new LRUCache<string, string>(NAME_CAPACITY, NAME_TTL_MS);

// Returns undefined when the user has no row / the lookup failed — callers
// already fall back to "Unknown User" for a missing name, exactly as they did
// when update_user_details failed.
const get_user_name = async (user_id: string): Promise<string | undefined> => {
  const cached = user_name_cache.get(user_id);
  if (cached !== null) return cached;
  try {
    const [row] = await db
      .select({ name: user_model.name })
      .from(user_model)
      .where(eq(user_model.id, user_id))
      .limit(1);
    if (row?.name) {
      user_name_cache.set(user_id, row.name);
      return row.name;
    }
    return undefined;
  } catch (error) {
    console.error(`[USER-NAME-CACHE] lookup failed for user ${user_id}:`, error);
    return undefined;
  }
};

// Write-through on rename so this process never serves the old name.
const set_cached_user_name = (user_id: string, name: string | null | undefined): void => {
  if (name) user_name_cache.set(user_id, name);
  else user_name_cache.delete(user_id);
};

const invalidate_user_names = (user_ids: string[]): void => {
  for (const id of user_ids) user_name_cache.delete(id);
};

export { get_user_name, set_cached_user_name, invalidate_user_names };
