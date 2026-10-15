// =============================================================================
// Sync capability lease proto:{uid} = "2" (SYNC_V2_PROTOCOL.md §3.13)
// =============================================================================
// Plumbing only in R1a, OFF by default (app_settings.sync_v2_proto_lease):
//   - set (EX 1 day) by a WS connect with ?proto=2 and by GET
//     /chat/sync/heads (R1b); poll v2 will too (R3);
//   - deleted by a WS connect WITHOUT proto and by every poll v1 request, so
//     a downgrade (reinstalling an old build) restores legacy storing.
// It is a HINT: a missing lease always means "store everything as today".
// Nothing reads it until R1b's pending suppression; `proto_leases()` is the
// reader that will join the router's presence pipeline.
//
// Do NOT switch the flag on before a client build that really implements
// sync proto 2 is in the field: once R1b reads it, a lease holder stops
// getting derivable events stored.
//
// With the flag off every call is a no-op: no Redis round trip.
// =============================================================================
import { sync_v2_flags } from "@/services/app-settings.service";
import { lease_action_for_connect, PROTO_V2 } from "./flags-core";
import { rfast, deadline } from "@/cluster/redis-fast";
import { k } from "@/cluster/keys";
import { count } from "@/utils/counters";
import { track } from "@/cluster/lifecycle";

const LEASE_TTL_S = 86_400;
const DEADLINE_MS = 1_000;

const enabled = (): boolean => sync_v2_flags().proto_lease;

const run = (label: string, p: Promise<unknown>): void => {
  track(
    p.then(() => count("SYNC", `proto_lease_${label}`)).catch((err: any) => {
      count("SYNC", "proto_lease_failed");
      console.error(`[SYNC] proto lease ${label} failed: ${err?.message ?? err}`);
    }),
  );
};

export const set_proto_lease_soon = (user_id: string): void => {
  if (!enabled() || !user_id) return;
  run("set", deadline(rfast.set(k.proto(user_id), PROTO_V2, "EX", LEASE_TTL_S), DEADLINE_MS, "proto set"));
};

export const clear_proto_lease_soon = (user_id: string): void => {
  if (!enabled() || !user_id) return;
  run("clear", deadline(rfast.del(k.proto(user_id)), DEADLINE_MS, "proto del"));
};

/** WS open: ?proto=2 sets the lease, anything else clears it. */
export const note_ws_connect_proto = (user_id: string, proto: string | null | undefined): void => {
  if (lease_action_for_connect(proto) === "set") set_proto_lease_soon(user_id);
  else clear_proto_lease_soon(user_id);
};

/**
 * Lease holders among `uids` (R1b reader). Flag off → empty set, i.e.
 * everybody keeps legacy storing. One pipelined round trip of GETs (not an
 * MGET: the keys sit in per-user hash slots, which a sharded Redis would
 * reject as CROSSSLOT, §13.5 / V15). Rejects on Redis error so the caller
 * can fall back to "store everything".
 */
export const proto_leases = async (uids: string[]): Promise<Set<string>> => {
  if (!enabled() || uids.length === 0) return new Set();
  const pipe = rfast.pipeline();
  for (const u of uids) pipe.get(k.proto(u));
  const res = (await deadline(pipe.exec(), DEADLINE_MS, "proto get")) ?? [];
  const out = new Set<string>();
  res.forEach(([err, v], i) => {
    if (!err && v === PROTO_V2) out.add(uids[i]!);
  });
  return out;
};
