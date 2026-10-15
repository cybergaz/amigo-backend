// =============================================================================
// [UNREAD-SHADOW] (SYNC_V2_PROTOCOL.md §3.6 "Shadow", §9 row 2 (h), §10)
// =============================================================================
// With sync_v2 = shadow, get_chat_list keeps SERVING the Redis unread counts
// and, off the request path, computes the derived count (§3.6, legacy
// floors, cap 100) for the same chats and logs where they differ. The R1b
// flip gate is the per-user mismatch rate measured here.
//
// Cost: one statement per user per SHADOW_EVERY_MS per worker (index-only on
// idx_messages_unread, so it only runs once 20261021b has built it).
// =============================================================================
import { pg_client } from "@/config/db";
import { sync_v2_flags } from "@/services/app-settings.service";
import { unread_shadow_ready } from "./flags-core";
import { derived_unread } from "./seq-queries";
import { compare_unread, type ServedUnread } from "./unread-compare";
import { count } from "@/utils/counters";
import { track } from "@/cluster/lifecycle";

const SHADOW_EVERY_MS = 10 * 60_000;
const SHADOW_MAX_USERS = 50_000;
const last_check = new Map<string, number>();

const due = (user_id: string, now: number): boolean => {
  const at = last_check.get(user_id);
  if (at !== undefined && now - at < SHADOW_EVERY_MS) return false;
  last_check.delete(user_id);
  last_check.set(user_id, now);
  if (last_check.size > SHADOW_MAX_USERS) {
    const oldest = last_check.keys().next().value;
    if (oldest !== undefined) last_check.delete(oldest);
  }
  return true;
};

/** Fire-and-forget; never throws, never delays the response. */
export const shadow_compare_unread = (user_id: string, served: ServedUnread[]): void => {
  if (served.length === 0 || !unread_shadow_ready(sync_v2_flags())) return;
  if (!due(user_id, Date.now())) return;
  track(
    (async () => {
      const derived = await derived_unread(pg_client, user_id, {
        chat_ids: served.map((s) => s.chat_id),
        legacy: true,
      });
      const { checked, mismatches } = compare_unread(served, derived);
      count("UNREAD-SHADOW", "users");
      count("UNREAD-SHADOW", "chats", checked);
      if (mismatches.length > 0) {
        count("UNREAD-SHADOW", "mismatch_users");
        count("UNREAD-SHADOW", "mismatch_chats", mismatches.length);
        console.warn(
          `[UNREAD-SHADOW] mismatch uid=${user_id} chats=${mismatches.length}/${checked} sample=${JSON.stringify(mismatches.slice(0, 5))}`,
        );
      }
    })().catch((err: any) => {
      count("UNREAD-SHADOW", "failed");
      console.error(`[UNREAD-SHADOW] compare failed uid=${user_id}: ${err?.message ?? err}`);
    }),
  );
};
