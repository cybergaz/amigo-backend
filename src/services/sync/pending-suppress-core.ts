// =============================================================================
// §3.13 pending suppression for proto-2 lease holders — pure rules
// =============================================================================
// A client that speaks sync proto 2 repairs everything that is numbered state
// from heads / delta / resolve, and it no longer acks per message. Storing
// those events for it anyway is the store-for-everyone write amplification
// §3.13 removes: every one would sit in Redis for a week and be written to
// missed_ws_messages 10 s later, never drained. So for a lease holder only
// the events the pull CANNOT rebuild are stored.
//
// Derivable (repaired by heads / delta / the GC verify path):
//   message:new          only with a seq (a persisted, numbered row; a frame
//                        without one — e.g. an unpersisted notice — is kept)
//   message:sent:ack     only is_sent:true (a refusal is not state anywhere)
//   message:status:ack, conversation:join, conversation:mark_read
//                        (receipts → read/delivered watermarks, others_*)
//   message:pin          (pin_seq), message:delete (mods)
//   conversation:action  only when persisted (system_message present)
// Everything else is stored as today: conversation:new, user:update,
// auth:force_logout, message:react, message:forward,
// conversation:disappearing, unpersisted conversation:action (join requests).
// =============================================================================
import type { VitalWSMessage } from "@/types/socket.types";

export const is_derivable_for_v2 = (msg: VitalWSMessage): boolean => {
  const p = (msg.payload ?? {}) as Record<string, any>;
  switch (msg.type) {
    case "message:new":
      return p.seq !== undefined && p.seq !== null;
    case "message:sent:ack":
      return p.is_sent === true;
    case "message:status:ack":
    case "conversation:join":
    case "conversation:mark_read":
    case "message:pin":
    case "message:delete":
      return true;
    case "conversation:action":
      return !!p.system_message && typeof p.system_message === "object";
    default:
      return false;
  }
};

/**
 * Bounded "who held a proto-2 lease recently" set, fed by the suppression
 * lookups. Read by the pending store's DB writer for the §3.13 counter
 * `[POLL] v2_undrained_db_writes` (DB writes for lease holders; target ≈ 0)
 * without a second Redis lookup. A hint: a user can drop their lease and
 * still be in here for up to `ttl_ms`.
 */
export class RecentSet {
  private m = new Map<string, number>();
  constructor(
    private readonly ttl_ms = 10 * 60_000,
    private readonly max = 50_000,
  ) { }

  add(uid: string, now = Date.now()): void {
    this.m.delete(uid);
    this.m.set(uid, now + this.ttl_ms);
    if (this.m.size > this.max) {
      const oldest = this.m.keys().next().value;
      if (oldest !== undefined) this.m.delete(oldest);
    }
  }

  has(uid: string, now = Date.now()): boolean {
    const exp = this.m.get(uid);
    if (exp === undefined) return false;
    if (exp <= now) {
      this.m.delete(uid);
      return false;
    }
    return true;
  }

  size(): number {
    return this.m.size;
  }
}
