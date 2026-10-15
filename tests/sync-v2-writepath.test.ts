// Sync v2 R1a write path (SYNC_V2_PROTOCOL.md §3.3, §3.7, §3.10, §3.13, §9
// row 2 (b)/(h)). Pure: flag parsing and the derived switches, the delivered
// coalescer, the shadow comparison, the mins rule, server-time expiry, and a
// few source contracts (every legacy PG pointer writer is guarded). The SQL
// in services/sync/write-queries.ts runs end to end against the real triggers
// on a throwaway Postgres (PGlite) outside the repo — see SYNC_V2_PROGRESS.md.
// Run: `bun test tests/sync-v2-writepath.test.ts`.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_SYNC_V2_FLAGS,
  clock_installed,
  dualwrite_active,
  flag_on,
  lease_action_for_connect,
  marker_on,
  parse_mode,
  parse_sync_v2_flags,
  server_expiry_active,
  shadow_active,
  unread_shadow_ready,
} from "@/services/sync/flags-core";
import { DeliveredCoalescer } from "@/services/sync/receipt-coalescer";
import { compare_unread } from "@/services/sync/unread-compare";
import {
  group_by_chat_sorted,
  is_uuid,
  mins_may_move,
  system_row_action,
  type ReceiptOutcome,
} from "@/services/sync/write-queries";
import { SYNC_V2_KEYS } from "@/services/sync/seq-queries";
import { resolve_expires_at } from "@/utils/message-time.utils";
import { marker_on as script_marker_on } from "../scripts/lib/sync-v2";

const SRC = join(import.meta.dir, "..", "src");
const src = (f: string) => readFileSync(join(SRC, f), "utf8");

describe("flags + markers", () => {
  test("defaults are the 'nothing new happens' values", () => {
    const f = DEFAULT_SYNC_V2_FLAGS;
    expect(f.mode).toBe("off");
    expect(dualwrite_active(f) || shadow_active(f) || server_expiry_active(f) || clock_installed(f)).toBe(false);
    expect(f.system_rows || f.proto_lease).toBe(false);
    expect(parse_sync_v2_flags([])).toMatchObject({ mode: "off", system_rows: false, proto_lease: false, server_expiry: false });
  });

  test("mode parsing is strict; anything unknown is off", () => {
    expect(parse_mode("shadow")).toBe("shadow");
    expect(parse_mode(" ON ")).toBe("on");
    expect(parse_mode({ mode: "shadow" })).toBe("shadow");
    for (const v of [undefined, null, 1, true, "1", "yes", "shadw", {}]) expect(parse_mode(v)).toBe("off");
  });

  test("boolean flags need an explicit on", () => {
    for (const v of [true, 1, "1", "on", "true", "YES", { enabled: true }]) expect(flag_on(v)).toBe(true);
    for (const v of [undefined, null, false, 0, "0", "false", "off", "", "maybe", {}, { enabled: "true" }]) expect(flag_on(v)).toBe(false);
  });

  test("marker rule matches the ledger scripts' marker_on", () => {
    for (const v of [undefined, null, false, 0, "", "0", "off", "OFF", 1, true, "1", { done: true }, "x"]) {
      expect(marker_on(v)).toBe(script_marker_on(v));
    }
  });

  test("rows → flags, and the derived switches", () => {
    const f = parse_sync_v2_flags([
      { key: SYNC_V2_KEYS.mode, value: "shadow" },
      { key: SYNC_V2_KEYS.system_rows, value: false },
      { key: SYNC_V2_KEYS.triggers, value: 1 },
      { key: SYNC_V2_KEYS.backfill, value: { done: true, rows: 5 } },
    ]);
    expect(f.loaded).toBe(true);
    expect(dualwrite_active(f) && shadow_active(f)).toBe(true);
    expect(server_expiry_active(f)).toBe(false); // shadow changes nothing visible
    expect(clock_installed(f)).toBe(true);
    expect(unread_shadow_ready(f)).toBe(false); // no post-backfill indexes yet
    const g = parse_sync_v2_flags([
      { key: SYNC_V2_KEYS.mode, value: "shadow" },
      { key: SYNC_V2_KEYS.backfill, value: { done: true } },
      { key: SYNC_V2_KEYS.indexes_post, value: 1 },
    ]);
    expect(unread_shadow_ready(g)).toBe(true);
    expect(server_expiry_active(parse_sync_v2_flags([{ key: SYNC_V2_KEYS.mode, value: "on" }]))).toBe(true);
    expect(server_expiry_active(parse_sync_v2_flags([{ key: SYNC_V2_KEYS.server_expiry, value: true }]))).toBe(true);
  });

  test("proto lease: only ?proto=2 sets it", () => {
    expect(lease_action_for_connect("2")).toBe("set");
    expect(lease_action_for_connect(" 2 ")).toBe("set");
    for (const v of [null, undefined, "", "1", "3", "v2"]) expect(lease_action_for_connect(v)).toBe("clear");
  });
});

describe("delivered coalescer", () => {
  const a = "0192f0a0-0000-7000-8000-000000000001";
  test("one item per (user, chat), deduped; drain empties", () => {
    const c = new DeliveredCoalescer();
    c.add("u1", "c1", [a, a, "x"]);
    c.add("u1", "c1", ["y"]);
    c.add("u1", "c2", ["z"]);
    c.add("u2", "c1", ["w"]);
    expect(c.size).toBe(5);
    expect(c.users).toBe(2);
    const out = c.drain();
    expect(out.get("u1")!.find((i) => i.chat_id === "c1")!.delivered_ids.sort()).toEqual([a, "x", "y"].sort());
    expect(out.get("u1")!.length).toBe(2);
    expect(c.size).toBe(0);
    expect(c.drain().size).toBe(0);
  });

  test("per-chat bound keeps the newest (largest UUIDv7) ids", () => {
    const c = new DeliveredCoalescer(3);
    c.add("u", "c", ["01", "05", "03"]);
    c.add("u", "c", ["04", "02"]);
    expect(c.size).toBe(3);
    expect(c.drain().get("u")![0]!.delivered_ids.sort()).toEqual(["03", "04", "05"]);
  });
});

describe("shadow unread comparison", () => {
  test("skips unnumbered chats, caps served at 100, case-insensitive ids", () => {
    const r = compare_unread(
      [
        { chat_id: "AA", unread: 3 },
        { chat_id: "bb", unread: 250 },
        { chat_id: "cc", unread: 7 },
        { chat_id: "dd", unread: 1 },
      ],
      [
        { chat_id: "aa", unread: 3, numbered: true },
        { chat_id: "bb", unread: 100, numbered: true },
        { chat_id: "cc", unread: 0, numbered: false },
        { chat_id: "dd", unread: 2, numbered: true },
      ],
    );
    expect(r.checked).toBe(3);
    expect(r.mismatches).toEqual([{ chat_id: "dd", derived: 2, served: 1 }]);
  });
});

describe("receipt mins rule (§3.7)", () => {
  const base: ReceiptOutcome = {
    chat_id: "c", status: "applied", chat_type: "group", seq_head: 10, r: 5, d: null,
    prev_read: 2, read_seq: 5, prev_deliv: 5, delivered_seq: 5, r_min2: 3, d_min2: 4,
  };
  test("refresh only when the member was in the bottom two (or no mins row)", () => {
    expect(mins_may_move(base)).toBe(true);                         // read 2 → 5, 2 ≤ r_min2 3
    expect(mins_may_move({ ...base, prev_read: 4 })).toBe(false);  // above r_min2, delivered unchanged
    expect(mins_may_move({ ...base, prev_read: 4, r_min2: null })).toBe(true);
    expect(mins_may_move({ ...base, prev_read: 5, read_seq: 5, prev_deliv: 3, delivered_seq: 6 })).toBe(true);
    expect(mins_may_move({ ...base, status: "noop" })).toBe(false);
  });
});

describe("write helpers", () => {
  test("group_by_chat_sorted groups and orders chats by id", () => {
    const g = group_by_chat_sorted([
      { id: "1", chat_id: "B" }, { id: "2", chat_id: "a" }, { id: "3", chat_id: "b" }, { id: "4", chat_id: "c" },
    ]);
    expect(g).toEqual([["a", ["2"]], ["b", ["1", "3"]], ["c", ["4"]]]);
  });

  test("system-row actions: persisted set and names the trigger keys on", () => {
    expect(system_row_action("member_added")).toBe("add");
    expect(system_row_action("member_removed")).toBe("remove");
    expect(system_row_action("member_left")).toBe("leave");
    expect(system_row_action("member_promoted")).toBe("role");
    expect(system_row_action("member_demoted")).toBe("role");
    expect(system_row_action("owner_changed")).toBe("owner");
    expect(system_row_action("chat_details:update")).toBe("chat_details:update");
    for (const a of ["join_request:new", "join_request:resolved", "chat_delete", "nope"]) expect(system_row_action(a)).toBeNull();
    // every name must be one messages_ai_sys reacts to
    const trg = readFileSync(join(import.meta.dir, "..", "scripts", "migrations", "20261020c-sync-v2-triggers.ts"), "utf8");
    for (const a of ["add", "remove", "leave", "role", "owner", "chat_details:update", "disappearing"]) expect(trg).toContain(`'${a}'`);
  });

  test("is_uuid", () => {
    expect(is_uuid("0192f0a0-0000-7000-8000-000000000001")).toBe(true);
    for (const v of ["", "x", null, 5, "0192f0a0-0000-7000-8000-00000000000"]) expect(is_uuid(v)).toBe(false);
  });
});

describe("server-time expiry (§3.10)", () => {
  const sent = new Date("2026-10-01T00:00:00Z");
  const now = new Date("2026-10-01T05:00:00Z");
  test("legacy counts from stored sent_at; server time from arrival; off → null", () => {
    expect(resolve_expires_at(3600, sent, false, now)!.toISOString()).toBe("2026-10-01T01:00:00.000Z");
    expect(resolve_expires_at(3600, sent, true, now)!.toISOString()).toBe("2026-10-01T06:00:00.000Z");
    expect(resolve_expires_at(null, sent, true, now)).toBeNull();
    expect(resolve_expires_at(undefined, sent, false, now)).toBeNull();
  });
});

describe("source contracts", () => {
  test("every legacy PG last-message writer is guarded by seq_head IS NULL (§3.3.4)", () => {
    const meta = src("cache-management/chat-meta.cache.ts");
    // set_last_message: both branches (monotone + allow_rewind)
    expect(meta.match(/isNull\(chat_model\.seq_head\)/g)?.length).toBe(2);
    // batch_set_last_message
    expect(meta).toContain("AND c.seq_head IS NULL");
    // broadcast_deletion's own pointer / pin write
    const chat = src("services/chat.services.ts");
    expect(chat).toContain("isNull(chat_model.seq_head)");
    // nothing else writes last_msg_id
    for (const f of ["services/message.services.ts", "services/chat-group.service.ts", "services/chat-broadcast.service.ts", "sockets/socket.service.ts"]) {
      expect(/set\(\{[^}]*last_msg_id/.test(src(f))).toBe(false);
    }
  });

  test("every legacy receipt input feeds apply_receipts", () => {
    const svc = src("sockets/socket.service.ts");
    expect(svc.match(/note_legacy_read\(payload\.user_id/g)?.length).toBe(2); // join + mark_read
    expect(svc).toContain("note_status_ack(recipient_id, payload.acks)");
    expect(src("services/message-status.service.ts")).toContain("note_delivered(recipient_id, conversation_id, [message_id])");
    expect(src("services/chat.services.ts")).toContain("note_clear(user_id, conversation_id)");
  });

  test("system rows and proto lease are flag-gated", () => {
    const chat = src("services/chat.services.ts");
    expect(chat).toMatch(/sync_v2_flags\(\)\.system_rows/);
    expect(src("services/disappearing.service.ts")).toMatch(/sync_v2_flags\(\)\.system_rows/);
    expect(src("services/sync/proto-lease.ts")).toMatch(/sync_v2_flags\(\)\.proto_lease/);
  });

  test("conversation:action keeps `message` the String text; the stored row rides as `system_message` (§3.10, §4.1)", () => {
    // Old apps (4.2.2) decode `message` as a REQUIRED String; an object there
    // would fail every member action on every old client.
    const chat = src("services/chat.services.ts");
    expect(chat).toContain("payload.system_message = {");
    expect(/payload\.message\s*=\s*\{/.test(chat)).toBe(false);
    expect(src("types/socket.types.ts")).toMatch(/system_message\?: \{ id: string; seq: number \| null; srv_ts: string \}/);
    // Cross-check against the old generated decoder when the app repo sits
    // next to this one (monorepo checkout); skipped otherwise.
    const g = join(import.meta.dir, "..", "..", "amigo-app", "lib", "types", "socket.types.g.dart");
    if (existsSync(g)) {
      const dart = readFileSync(g, "utf8");
      const from = dart.slice(dart.indexOf("_$ConversationActionPayloadFromJson("));
      expect(from.slice(0, from.indexOf("_$ConversationActionPayloadToJson("))).toContain("message: json['message'] as String,");
    }
  });

  test("the sweeper is a per-chat single runner, not a multi-chat claim", () => {
    const sw = src("cache-management/disappearing-sweeper.ts");
    expect(sw).toContain("run_pg_singleton_sql(JOB");
    expect(sw).not.toContain("FOR UPDATE SKIP LOCKED");
  });
});
