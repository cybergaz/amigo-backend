// Sync v2 R1a schema: the ledger scripts and the Drizzle models must agree
// (SYNC_V2_PROTOCOL.md §3.1 "Drizzle models … identical names and predicates"),
// because drizzle-kit push becomes legal again after 20261021b and would
// otherwise rebuild or drop live indexes. Pure — reads the script files as
// text and never runs them (importing a ledger script would execute it).
// The SQL itself is exercised end to end against a throwaway Postgres
// (PGlite) outside the repo; see the R1a notes in SYNC_V2_PROGRESS.md.
// Run: `bun test tests/sync-v2-schema.test.ts`.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getTableConfig } from "drizzle-orm/pg-core";
import { message_model, missed_ws_messages_model } from "@/models/message.model";
import { chat_model, chat_member_model, chat_receipt_mins_model } from "@/models/chat.model";
import { marker_on } from "../scripts/lib/sync-v2";
import { ioredis_reader } from "../scripts/lib/sync-v2-watermarks";
import { SYNC_V2_KEYS } from "@/services/sync/seq-queries";

const MIG = join(import.meta.dir, "..", "scripts", "migrations");
const read = (f: string) => readFileSync(join(MIG, f), "utf8");

const TABLES = {
  messages: message_model,
  chats: chat_model,
  chat_members: chat_member_model,
  chat_receipt_mins: chat_receipt_mins_model,
  missed_ws_messages: missed_ws_messages_model,
} as const;

const columns_of = (t: keyof typeof TABLES) => new Set(getTableConfig(TABLES[t] as any).columns.map((c) => c.name));
const indexes_of = (t: keyof typeof TABLES) =>
  new Map(getTableConfig(TABLES[t] as any).indexes.map((i) => [i.config.name!, i.config.unique]));

describe("sync v2 ledger ↔ drizzle models", () => {
  test("every column 20261020a adds is declared in the models", () => {
    const src = read("20261020a-sync-v2-columns.ts");
    const adds = [...src.matchAll(/ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS (\w+)/g)].map((m) => [m[1]!, m[2]!] as const);
    expect(adds.length).toBe(16);
    for (const [table, col] of adds) expect(columns_of(table as keyof typeof TABLES).has(col)).toBe(true);
    for (const col of ["r_min1", "r_min1_user", "r_min2", "d_min1", "d_min1_user", "d_min2", "updated_at", "chat_id"]) {
      expect(columns_of("chat_receipt_mins").has(col)).toBe(true);
    }
  });

  test("every index the ledger builds is declared with the same name and uniqueness", () => {
    const src = read("20261020b-sync-v2-indexes-pre.ts") + read("20261021b-sync-v2-indexes-post.ts");
    const built = [...src.matchAll(/CREATE (UNIQUE )?INDEX CONCURRENTLY IF NOT EXISTS (\w+) ON (\w+)/g)];
    expect(built.length).toBe(5);
    for (const m of built) {
      const decl = indexes_of(m[3] as keyof typeof TABLES);
      expect(decl.has(m[2]!)).toBe(true);
      expect(decl.get(m[2]!)).toBe(Boolean(m[1]));
    }
  });

  test("seq_head DEFAULT 0 is installed by the trigger step, never by the columns step", () => {
    // Set before the triggers exist, chats created in between would look
    // numbered while their messages get no seq, and the backfill would skip them.
    expect(read("20261020a-sync-v2-columns.ts")).not.toMatch(/seq_head SET DEFAULT/);
    expect(read("20261020c-sync-v2-triggers.ts")).toMatch(/ALTER COLUMN seq_head SET DEFAULT 0/);
  });

  test("the trigger script installs exactly the triggers other phases rely on", () => {
    const names = [...read("20261020c-sync-v2-triggers.ts").matchAll(/`CREATE TRIGGER (\w+)/g)].map((m) => m[1]).sort();
    expect(names).toEqual([
      "chat_members_minwm", "chat_members_minwm_del", "chat_members_minwm_ins", "chat_members_minwm_stmt", "chat_members_seq",
      "chats_bu_pin", "messages_ad_ptr", "messages_ai_sys", "messages_au_del", "messages_bi", "messages_bu_del",
    ]);
  });

  test("20261020c waits for the R1a build; the backfill too", () => {
    // Old build + triggers + seq_head DEFAULT 0 = numbered chats written by
    // unguarded legacy pointer writers.
    for (const f of ["20261020c-sync-v2-triggers.ts", "20261021-sync-v2-seq-backfill.ts"]) {
      expect(read(f)).toMatch(/require_marker\(sql, MARKERS\.code_deployed/);
    }
  });

  test("idx_chat_members_wm indexes no watermark column (receipt writes stay HOT)", () => {
    const post = read("20261021b-sync-v2-indexes-post.ts");
    const ddl = post.slice(post.indexOf("CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chat_members_wm"));
    const stmt = ddl.slice(0, ddl.indexOf("`"));
    for (const col of ["read_seq", "delivered_seq", "INCLUDE"]) expect(stmt).not.toContain(col);
  });
});

describe("sync v2 script helpers", () => {
  test("marker_on: only an explicit, truthy value counts", () => {
    for (const v of [1, true, "1", "on", { done: true }]) expect(marker_on(v)).toBe(true);
    for (const v of [undefined, null, false, 0, "", "0", "off", "OFF"]) expect(marker_on(v)).toBe(false);
  });

  test("marker keys are the canonical app_settings keys", () => {
    expect(SYNC_V2_KEYS.code_deployed).toBe("sync_v2_code_deployed");
    expect(SYNC_V2_KEYS.dualwrite).toBe("sync_v2_dualwrite");
    expect(SYNC_V2_KEYS.mode).toBe("sync_v2");
  });

  test("Redis reader: a missing unread field is UNKNOWN, never 0", async () => {
    const data: Record<string, string | null> = {
      "user_receipts:a|c": JSON.stringify({ last_read_msg_id: "r1", last_delivered_msg_id: "d1" }),
      "user_unread:a|c": "0",
      "user_receipts:b|c": "{not json",
      "user_unread:b|c": null,
      "user_receipts:x|c": null,
      "user_unread:x|c": "7",
    };
    const fake = {
      pipeline() {
        const q: string[] = [];
        return {
          hget(key: string, field: string) { q.push(`${key}|${field}`); return this; },
          async exec() { return q.map((k) => [null, data[k] ?? null]); },
        };
      },
    };
    const m = await ioredis_reader(fake).read("c", ["a", "b", "x"]);
    expect(m.get("a")).toEqual({ read_id: "r1", delivered_id: "d1", unread: 0 });
    expect(m.get("b")).toEqual({ read_id: null, delivered_id: null, unread: null });
    expect(m.get("x")).toEqual({ read_id: null, delivered_id: null, unread: 7 });
  });
});
