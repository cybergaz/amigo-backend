import { CLUSTER_MAX } from "./identity";

// =============================================================================
// Cross-worker routing mode (SYNC_V2 RC-2, §13.13 gate items 5–8)
// =============================================================================
//   local  — exactly today's single-process behaviour: delivery, presence,
//            snapshot, debounce and is_user_online read only this process's
//            maps. No presence keys are written, no inbox is used. Default
//            while CLUSTER_MAX=1.
//   shadow — decisions stay local (as `local`), but the presence registry is
//            written (claim / refresh / release / bg / poll) and a sample of
//            fan-outs is classified against it too, counting
//            `[CLUSTER] presence_mismatch`. Safe on prod at N=1: it only adds
//            Redis writes off the hot path. This is how gate item 5 is
//            measured before anything depends on the registry.
//   on     — the registry is authoritative: router with deadlines, per-worker
//            inbox, async is_user_online, edge-triggered online, presence-
//            aware debounce / eviction, evict + 4009 across workers. Default
//            when CLUSTER_MAX>1. At N=1 it still delivers in-process: a
//            recipient on this worker never costs a Redis round trip, and
//            while no live sibling exists the rest is classified from the
//            local maps too (router.ts "sole worker").
//
// Mixed modes across live workers are a misconfiguration: a `local` worker
// writes no presence, so `on` siblings see its users as offline (FCM + the
// pending store still cover them — degraded, never lost).

type RoutingMode = "local" | "shadow" | "on";

const parse_mode = (raw: string | undefined, cluster_max: number): RoutingMode => {
  const v = (raw || "").trim().toLowerCase();
  if (v === "local" || v === "off") return "local";
  if (v === "shadow") return "shadow";
  if (v === "on") return "on";
  if (v) console.warn(`[CLUSTER] ignoring invalid CLUSTER_ROUTING "${raw}"`);
  return cluster_max > 1 ? "on" : "local";
};

const ROUTING_MODE: RoutingMode = parse_mode(process.env.CLUSTER_ROUTING, CLUSTER_MAX);

// Presence keys are written (shadow + on).
const presence_writes = (): boolean => ROUTING_MODE !== "local";
// Presence decides delivery / announcements (on only).
const presence_authoritative = (): boolean => ROUTING_MODE === "on";

export { ROUTING_MODE, parse_mode, presence_writes, presence_authoritative };
export type { RoutingMode };
