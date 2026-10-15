// Sync v2 R1b leftovers (SYNC_V2_PROTOCOL.md §3.12, §4.3, §14.5 item 5):
// the delete-unpin `pin` on message:delete (user deletes AND the sweeper's
// emit), pinned_message on the LIVE message:pin frame only, socket:ready
// announcing proto 2, derived_unread on the partial chat_members index and
// the delete-frame read as PK probes. Pure helpers plus source contracts that
// keep 'off' / 'shadow' byte-identical; the SQL and the real fan-out run on
// the PGlite harnesses (scratchpad pglite/r1b_app.ts, readapi.ts,
// fix_plans.ts). Run: `bun test tests/r1b-leftovers.test.ts`.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SYNC_V2_FLAGS, type SyncV2Flags } from "@/services/sync/flags-core";
import { rollout_bucket, ws_ready_proto } from "@/services/sync/read-core";
import { delete_unpin_field } from "@/services/sync/frame-fields";
import { fanout_frames } from "@/cluster/router-core";

const SRC = join(import.meta.dir, "..", "src");
const src = (f: string) => readFileSync(join(SRC, f), "utf8");

const flags = (over: Omit<Partial<SyncV2Flags>, "markers"> & { markers?: Partial<SyncV2Flags["markers"]> } = {}): SyncV2Flags => ({
  ...DEFAULT_SYNC_V2_FLAGS,
  ...over,
  markers: { ...DEFAULT_SYNC_V2_FLAGS.markers, ...(over.markers ?? {}) },
} as SyncV2Flags);
const READY = { backfill: true, indexes_post: true };
const OPEN = flags({ mode: "on", markers: READY, rollout_pct: 100 });

// Two users on either side of a 50% rollout (the gate's own bucket function).
const uid_in_bucket = (want_low: boolean): string => {
  for (let i = 0; ; i++) {
    const u = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    if ((rollout_bucket(u) < 50) === want_low) return u;
  }
};
const IN = uid_in_bucket(true);
const OUT = uid_in_bucket(false);

describe("socket:ready proto (§4.3, §14.5 item 5)", () => {
  test("2 only for ?proto=2 while the gate is open for the user", () => {
    expect(ws_ready_proto(IN, "2", OPEN)).toBe(2);
    expect(ws_ready_proto(IN, " 2 ", OPEN)).toBe(2); // parsed like the proto:{uid} lease
    const half = flags({ mode: "on", markers: READY, rollout_pct: 50 });
    expect(ws_ready_proto(IN, "2", half)).toBe(2);
    expect(ws_ready_proto(OUT, "2", half)).toBe(1); // outside the rollout bucket
  });
  test("every other connect keeps today's 1", () => {
    for (const q of [null, undefined, "", "1", "3", "v2", "22"]) expect(ws_ready_proto(IN, q, OPEN)).toBe(1);
    expect(ws_ready_proto(IN, "2", DEFAULT_SYNC_V2_FLAGS)).toBe(1);                                   // off (default)
    expect(ws_ready_proto(IN, "2", flags({ mode: "shadow", markers: READY, rollout_pct: 100 }))).toBe(1);
    expect(ws_ready_proto(IN, "2", flags({ mode: "on", markers: { backfill: true }, rollout_pct: 100 }))).toBe(1); // markers missing
    expect(ws_ready_proto(IN, "2", flags({ mode: "on", markers: READY, rollout_pct: 0 }))).toBe(1);     // kill switch
  });
  test("socket.server sends the computed value (no constant 1 left behind)", () => {
    const s = src("sockets/socket.server.ts");
    expect(s).toContain('const query_proto = url.searchParams.get("proto");');
    expect(s).toContain("note_ws_connect_proto(user_id, query_proto);");
    expect(s).toContain("proto: ws_ready_proto(user_id, query_proto, sync_v2_flags()),");
    expect(s).not.toContain("SERVER_SYNC_PROTO");
  });
});

describe("pinned_message on the LIVE frame only (§3.12)", () => {
  const ts = new Date("2026-10-15T00:00:00.000Z");
  const stored = { type: "message:pin", payload: { conv_id: "c", message_id: "m", message_type: "text", sender_id: "a", pin: true, pin_seq: 7 }, ws_timestamp: ts };
  const live = { ...stored, payload: { ...stored.payload, pinned_message: { id: "m", seq: 3, body: "secret body" } } };

  test("sockets get the body, the pending store never does", () => {
    const f = fanout_frames(stored, live);
    expect(JSON.parse(f.live).payload.pinned_message).toEqual({ id: "m", seq: 3, body: "secret body" });
    expect(f.store).toBe(stored);
    expect(JSON.stringify(f.store)).not.toContain("pinned_message");
    expect(JSON.stringify(f.store)).not.toContain("secret body");
  });
  test("without a live variant the socket frame is byte-identical to before", () => {
    expect(fanout_frames(stored).live).toBe(JSON.stringify(stored));
    expect(fanout_frames(stored, null).live).toBe(JSON.stringify(stored));
  });
  test("a live variant of another event type is ignored", () => {
    const other = { ...live, type: "message:delete" };
    expect(fanout_frames(stored, other).live).toBe(JSON.stringify(stored));
  });
  test("contracts: only set_pin in 'on' passes a live variant; broadcast_message stores `message`", () => {
    const h = src("sockets/socket.handlers.ts");
    expect(h).toContain("const { live, store } = fanout_frames(data.message, data.live_message);");
    expect(h).toContain("is_allowed_event(store.type) ? (store as VitalWSMessage) : undefined,");
    const p = src("services/sync/set-pin.ts");
    expect(p).toContain('const v2 = sync_v2_flags().mode === "on";');
    expect(p).toContain("...(v2 && applied.pinned_message\n          ? { live_message:");
    // The stored payload never gets the body (only pin_seq, and only in 'on').
    expect(p).toContain("if (v2) payload.pin_seq = applied.pin_seq;");
    expect(p).not.toMatch(/payload\.pinned_message\s*=/);
    // FCM's projection strips it too, in case a stored frame ever had one.
    expect(src("services/fcm-batch.service.ts")).toContain("const { meta: _meta, pinned_message: _pin, ...rest } = p;");
    // live_message is set nowhere else.
    for (const f of ["services/chat.services.ts", "services/message.services.ts", "sockets/socket.service.ts", "services/chat-broadcast.service.ts"]) {
      expect(src(f)).not.toContain("live_message:");
    }
  });
});

describe("delete-unpin pin on message:delete (§3.12), user deletes and the sweeper", () => {
  test("sweeper-shaped block: pin_seq allocated inside or after the delete's block → pin", () => {
    // A sweeper batch takes one clock block for the chat (mod_seq 101..104);
    // the chats_bu_pin trigger stamps pin_seq from the same clock.
    const mods = [{ mod_seq: 101 }, { mod_seq: 102 }, { mod_seq: 103 }, { mod_seq: 104 }];
    expect(delete_unpin_field({ pinned_msg_id: null, pin_seq: 102 }, mods)).toEqual({ pinned_msg_id: null, pin_seq: 102 });
    expect(delete_unpin_field({ pinned_msg_id: null, pin_seq: 105 }, mods)).toEqual({ pinned_msg_id: null, pin_seq: 105 });
    expect(delete_unpin_field({ pinned_msg_id: null, pin_seq: 100 }, mods)).toBeUndefined(); // unpinned before the delete
    expect(delete_unpin_field({ pinned_msg_id: null, pin_seq: null }, mods)).toBeUndefined(); // unnumbered chat
  });
  test("contracts: 'on' only, the sweeper goes through broadcast_deletion, off payload unchanged", () => {
    const c = src("services/chat.services.ts");
    expect(c).toContain("if (v2_on(sync_v2_flags())) {\n    try {\n      frame_state = await delete_frame_state_sql(pg_client, chat_id, message_ids);");
    expect(c).toContain("const pin = frame_state ? delete_unpin_field(frame_state, frame_state.mods) : undefined;");
    // off / shadow: frame_state stays null → exactly {sender_id, conv_id, message_ids}.
    expect(c).toContain(
      'const payload: DeleteMessagePayload = {\n    sender_id: actor_id ?? "",\n    conv_id: chat_id,\n    message_ids,\n' +
      "    ...(frame_state ? { mods: frame_state.mods } : {}),\n    ...(pin ? { pin } : {}),\n  };",
    );
    expect(src("cache-management/disappearing-sweeper.ts")).toContain("await broadcast_deletion(chat_id, rows.map((r) => r.id), null);");
  });
  test("contract: the delete-frame read is one PK probe per id (LATERAL, never flattened)", () => {
    const q = src("services/sync/read-queries.ts");
    expect(q).toContain("FROM (SELECT DISTINCT u.id FROM unnest(${sql.array(ids)}::uuid[]) AS u(id)) x");
    expect(q).toMatch(/WHERE m\.id = x\.id AND m\.chat_id = c\.id\s+AND m\.deleted_at IS NOT NULL AND m\.mod_seq IS NOT NULL\s+LIMIT 1\) p\) AS mods/);
  });
});

describe("derived_unread uses the partial (user_id, chat_id) index", () => {
  test("repeats the indexes' removed_at IS NULL predicate", () => {
    const q = src("services/sync/seq-queries.ts");
    expect(q).toMatch(/WHERE cm\.user_id = \$\{user_id\}[\s\S]{0,400}?AND cm\.removed_at IS NULL\n/);
  });
});
