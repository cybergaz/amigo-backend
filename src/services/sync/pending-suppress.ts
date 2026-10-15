// =============================================================================
// §3.13 pending suppression — I/O (rules: pending-suppress-core.ts)
// =============================================================================
// router.deliver asks this which recipients get the vital frame stored.
//   - Old apps ALWAYS get today's store: a missing lease (any build that does
//     not connect with ?proto=2), a user outside the rollout bucket, a gate
//     that is not open (markers), or any lookup failure → store.
//   - Active only with sync_v2 = 'on' AND sync_v2_proto_lease on; otherwise
//     this returns `recipients` without touching Redis.
//   - Cost when active: one pipelined round trip of GETs (proto:{uid}) for
//     the gate-passing recipients of a derivable event, 1 s deadline.
// Counters ([POLL]): v2_suppressed (entries not stored), v2_suppress_lookup_failed.
// =============================================================================
import type { VitalWSMessage } from "@/types/socket.types";
import { sync_v2_flags } from "@/services/app-settings.service";
import { count } from "@/utils/counters";
import { pending_suppression_active } from "./flags-core";
import { sync_v2_gate } from "./read-core";
import { proto_leases } from "./proto-lease";
import { RecentSet, is_derivable_for_v2 } from "./pending-suppress-core";

const recent_holders = new RecentSet();

/** Was `uid` a proto-2 lease holder at a recent fan-out (hint, §3.13 counter)? */
export const was_recent_lease_holder = (uid: string): boolean => recent_holders.has(uid);

export const pending_store_recipients = async (
  recipients: string[],
  msg: VitalWSMessage,
): Promise<string[]> => {
  const f = sync_v2_flags();
  if (!pending_suppression_active(f) || !is_derivable_for_v2(msg)) return recipients;
  // Pure per-user gate first (no I/O): a user the gate keeps on v1 cannot
  // pull, so their lease (if any) must not stop the store.
  const candidates = recipients.filter((uid) => sync_v2_gate(uid, f).ok);
  if (candidates.length === 0) return recipients;
  let holders: Set<string>;
  try {
    holders = await proto_leases(candidates);
  } catch {
    count("POLL", "v2_suppress_lookup_failed");
    return recipients;
  }
  if (holders.size === 0) return recipients;
  for (const uid of holders) recent_holders.add(uid);
  count("POLL", "v2_suppressed", holders.size);
  return recipients.filter((uid) => !holders.has(uid));
};
