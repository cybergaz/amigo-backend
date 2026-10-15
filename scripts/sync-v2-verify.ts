#!/usr/bin/env bun
/**
 * Sync v2 verification (SYNC_V2_PROTOCOL.md §3.4 "sync-v2-verify", §9 row 2 (g)).
 *
 *   bun run scripts/sync-v2-verify.ts                 read-only checks + active tests in a ROLLED-BACK transaction
 *   bun run scripts/sync-v2-verify.ts --quick         skip the full-table scans
 *   bun run scripts/sync-v2-verify.ts --no-active     read-only checks only
 *   bun run scripts/sync-v2-verify.ts --concurrency   also run the parallel-insert test on a COMMITTED scratch
 *                                                     chat (no members), deleted again at the end
 *   bun run scripts/sync-v2-verify.ts --redis[=N]     per-user histogram of derived vs Redis unread for N users
 *                                                     (default 200, most recently seen; Redis is only READ)
 *
 * Exit 0 when every check passes (WARN lines do not fail), 1 otherwise.
 *
 * The active tests create scratch users/chats/messages inside one transaction
 * and ROLL IT BACK, so nothing survives — they exercise the real triggers on
 * this database: numbering, duplicates, delete/pin clock values, DM
 * hide → send → revive, group leave raising the mins, the account-delete
 * ghost row, and a clear replayed with an old upto_seq.
 */
import postgres from "postgres";
import { derived_unread, others_watermarks, apply_clear, UNREAD_CAP } from "../src/services/sync/seq-queries";
import { MARKERS, flag, get_marker, index_state, marker_on, open_sql, opt } from "./lib/sync-v2";

type Sql = postgres.Sql<{}>;
type Tx = postgres.TransactionSql<{}>;

let failures = 0;
const pass = (name: string, detail = "") => console.log(`  PASS ${name}${detail ? `  (${detail})` : ""}`);
const fail = (name: string, detail = "") => { failures++; console.log(`  FAIL ${name}${detail ? `  (${detail})` : ""}`); };
const warn = (name: string, detail = "") => console.log(`  WARN ${name}${detail ? `  (${detail})` : ""}`);
const check = (ok: boolean, name: string, detail = "") => (ok ? pass(name, detail) : fail(name, detail));

const QUICK = flag("quick");

// ── Read-only checks ────────────────────────────────────────────────────────

async function readonly_checks(sql: Sql) {
  console.log("\n▶ read-only");

  const [cs] = await sql<{ total: number; unnumbered: number }[]>`
    SELECT count(*)::int AS total, count(*) FILTER (WHERE seq_head IS NULL)::int AS unnumbered FROM chats`;
  check(cs!.unnumbered === 0, "every chat numbered (seq_head NOT NULL)", `${cs!.unnumbered}/${cs!.total} unnumbered`);

  if (!QUICK) {
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM messages WHERE seq IS NULL`;
    check(n === 0, "no NULL seq", `${n} rows`);

    const [bad] = await sql<{ above: number; mod_lt: number }[]>`
      SELECT count(*) FILTER (WHERE m.seq > c.seq_head OR m.mod_seq > c.seq_head)::int AS above,
             count(*) FILTER (WHERE m.mod_seq < m.seq)::int AS mod_lt
        FROM messages m JOIN chats c ON c.id = m.chat_id
       WHERE m.seq IS NOT NULL AND c.seq_head IS NOT NULL`;
    check(bad!.above === 0, "seq / mod_seq <= seq_head", `${bad!.above} rows above head`);
    check(bad!.mod_lt === 0, "mod_seq >= seq", `${bad!.mod_lt} rows`);
  }

  const uniq = await index_state(sql, "uniq_messages_chat_seq");
  if (uniq?.valid) {
    pass("no duplicate (chat_id, seq)", "uniq_messages_chat_seq is valid");
  } else if (!QUICK) {
    const d = await sql`SELECT 1 FROM messages WHERE seq IS NOT NULL GROUP BY chat_id, seq HAVING count(*) > 1 LIMIT 1`;
    check(d.length === 0, "no duplicate (chat_id, seq)", "uniq index not built yet — scanned");
  } else {
    warn("duplicate check skipped", "--quick and uniq_messages_chat_seq not valid yet");
  }
  for (const idx of ["idx_messages_chat_created", "uniq_messages_chat_seq", "idx_messages_chat_modchg", "idx_messages_unread", "idx_chat_members_wm"]) {
    const st = await index_state(sql, idx);
    if (!st) warn(`index ${idx} missing`);
    else check(st.valid, `index ${idx} valid`);
  }

  // last_msg_id = newest visible row by seq. An expired-but-unswept pointer is
  // a WARN: the sweeper's soft delete rewinds it.
  const ptr = await sql<{ id: string; last_msg_id: string | null; want: string | null; ptr_expired: boolean }[]>`
    SELECT c.id, c.last_msg_id, v.id AS want,
           COALESCE((SELECT m.expires_at <= now() FROM messages m WHERE m.id = c.last_msg_id), false) AS ptr_expired
      FROM chats c
      LEFT JOIN LATERAL (
        SELECT m.id FROM messages m
         WHERE m.chat_id = c.id AND m.deleted_at IS NULL AND m.seq IS NOT NULL
           AND (m.expires_at IS NULL OR m.expires_at > now())
         ORDER BY m.seq DESC LIMIT 1) v ON true
     WHERE c.seq_head IS NOT NULL AND c.last_msg_id IS DISTINCT FROM v.id
     LIMIT 200`;
  const hard = ptr.filter((r) => !r.ptr_expired);
  check(hard.length === 0, "last_msg_id = max visible seq", hard.slice(0, 5).map((r) => r.id).join(", ") || "all chats");
  if (ptr.length > hard.length) warn("pointer on an expired, not yet swept row", `${ptr.length - hard.length} chat(s)`);

  const [lp] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM chats c LEFT JOIN messages m ON m.id = c.last_msg_id
     WHERE c.seq_head IS NOT NULL AND c.last_msg_id IS NOT NULL AND m.seq IS DISTINCT FROM c.last_seq`;
  check(lp!.n === 0, "last_seq = seq(last_msg_id)", `${lp!.n} chats`);

  const [wm] = await sql<{ d_lt_r: number; above: number }[]>`
    SELECT count(*) FILTER (WHERE cm.delivered_seq < cm.read_seq)::int AS d_lt_r,
           count(*) FILTER (WHERE cm.read_seq > c.seq_head OR cm.delivered_seq > c.seq_head)::int AS above
      FROM chat_members cm JOIN chats c ON c.id = cm.chat_id WHERE c.seq_head IS NOT NULL`;
  check(wm!.d_lt_r === 0, "delivered_seq >= read_seq", `${wm!.d_lt_r} memberships`);
  check(wm!.above === 0, "watermarks <= seq_head", `${wm!.above} memberships`);

  // A shell shows seq <= left_seq, so a leaver's freeze point can never be
  // below their join point or below a message their PG cursors say they got
  // (cursors stop moving at the leave). read_seq is no bound: 20261022 may
  // take it from the Redis unread count, which is relative to today's head.
  // NULL is expected only until 20261022 has run (leavers from before the
  // triggers); after that it is a FAIL.
  const [lf] = await sql<{ n: number; nulls: number }[]>`
    SELECT count(*) FILTER (WHERE cm.left_seq < GREATEST(cm.joined_seq,
             COALESCE((SELECT m.seq FROM messages m WHERE m.id = cm.last_read_msg_id AND m.chat_id = cm.chat_id), 0),
             COALESCE((SELECT m.seq FROM messages m WHERE m.id = cm.last_delivered_msg_id AND m.chat_id = cm.chat_id), 0)))::int AS n,
           count(*) FILTER (WHERE cm.left_seq IS NULL)::int AS nulls
      FROM chat_members cm JOIN chats c ON c.id = cm.chat_id
     WHERE c.seq_head IS NOT NULL AND cm.status = 'left' AND cm.user_id IS NOT NULL`;
  check(lf!.n === 0, "left_seq >= joined_seq and the leaver's cursors", `${lf!.n} memberships`);
  if (lf!.nulls > 0) {
    const wm_done = marker_on(await get_marker(sql, MARKERS.watermarks));
    (wm_done ? fail : warn)("left members without left_seq", `${lf!.nulls} memberships${wm_done ? "" : " (fills on 20261022)"}`);
  }

  // Mins may LAG the members (coalesced runner) but must never be ABOVE them:
  // an r_min1 above the true lowest would paint a blue tick nobody earned.
  const mins = await sql<{ chat_id: string; r_min1: string; true_r: string | null; d_min1: string; true_d: string | null }[]>`
    SELECT x.chat_id, x.r_min1::text, t.r::text AS true_r, x.d_min1::text, t.d::text AS true_d
      FROM chat_receipt_mins x JOIN chats c ON c.id = x.chat_id
      CROSS JOIN LATERAL (
        SELECT min(GREATEST(cm.read_seq, cm.joined_seq)) AS r,
               min(GREATEST(cm.delivered_seq, cm.read_seq, cm.joined_seq)) AS d
          FROM chat_members cm
         WHERE cm.chat_id = x.chat_id AND cm.status = 'active' AND cm.user_id IS NOT NULL
           AND (cm.removed_at IS NULL OR c.type = 'dm')) t
     WHERE (t.r IS NOT NULL AND x.r_min1 > t.r) OR (t.d IS NOT NULL AND x.d_min1 > t.d)
     LIMIT 50`;
  check(mins.length === 0, "receipt mins never above the members", mins.slice(0, 3).map((m) => m.chat_id).join(", ") || "ok");
}

// ── Derived vs Redis unread histogram ───────────────────────────────────────

async function redis_histogram(sql: Sql, n_users: number) {
  console.log(`\n▶ derived vs Redis unread (${n_users} users)`);
  if (!process.env.REDIS_URL) { warn("REDIS_URL not set — histogram skipped"); return; }
  const { default: Redis } = await import("ioredis");
  const redis = new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 3 });
  await redis.connect();
  try {
    const users = await sql<{ id: string }[]>`
      SELECT id FROM users ORDER BY last_seen DESC NULLS LAST LIMIT ${n_users}`;
    const buckets: Record<string, number> = { "0": 0, "1": 0, "2-5": 0, "6-20": 0, ">20": 0 };
    let users_mismatch = 0, pairs = 0;
    for (const { id } of users) {
      const derived = await derived_unread(sql, id, { legacy: true });
      const cached = await redis.hgetall(`user_unread:${id}`);
      let any = false;
      for (const row of derived) {
        if (!(row.chat_id in cached)) continue;      // missing key = unknown, not 0
        pairs++;
        const r = Math.min(Number(cached[row.chat_id]) || 0, UNREAD_CAP);
        const diff = Math.abs(r - row.unread);
        const b = diff === 0 ? "0" : diff === 1 ? "1" : diff <= 5 ? "2-5" : diff <= 20 ? "6-20" : ">20";
        buckets[b]!++;
        if (diff) any = true;
      }
      if (any) users_mismatch++;
    }
    console.log(`  |derived - redis| over ${pairs} (user, chat) pairs: ${JSON.stringify(buckets)}`);
    const rate = users.length ? users_mismatch / users.length : 0;
    (rate < 0.005 ? pass : warn)("per-user mismatch rate", `${(rate * 100).toFixed(2)}% of ${users.length} users (R1b gate: < 0.5%)`);
  } finally {
    redis.disconnect();
  }
}

// ── Active tests (rolled back) ──────────────────────────────────────────────

class Rollback extends Error {}

async function active_tests(sql: Sql) {
  console.log("\n▶ active (one transaction, rolled back)");
  try {
    await sql.begin(async (tx: Tx) => {
      await tx`SET LOCAL lock_timeout = '3s'`;
      const tag = `vfy${Date.now().toString(36)}`;
      const mk_user = async (n: string) =>
        (await tx<{ id: string }[]>`INSERT INTO users (name, role) VALUES (${`${tag}-${n}`}, 'user') RETURNING id`)[0]!.id;
      const [A, B, C] = [await mk_user("a"), await mk_user("b"), await mk_user("c")];
      const mk_chat = async (type: string) =>
        (await tx<{ id: string; seq_head: string }[]>`
          INSERT INTO chats (type, title) VALUES (${type}, ${tag}) RETURNING id, seq_head::text`)[0]!;
      const send = async (chat: string, from: string | null, extra: { deleted?: boolean; type?: string; meta?: object } = {}) => {
        const id = crypto.randomUUID();
        const [r] = await tx<{ seq: string | null; mod_seq: string | null }[]>`
          INSERT INTO messages (id, chat_id, sender_id, type, body, seq, mod_seq, meta, deleted_at)
          VALUES (${id}, ${chat}, ${from}, ${extra.type ?? "text"}, 'x', 999999, 999999,
                  ${extra.meta ? tx.json(extra.meta as any) : null}, ${extra.deleted ? new Date() : null})
          RETURNING seq::text, mod_seq::text`;
        return { id, seq: r!.seq === null ? null : Number(r!.seq), mod_seq: r!.mod_seq === null ? null : Number(r!.mod_seq) };
      };
      const head = async (chat: string) =>
        (await tx<{ seq_head: string; last_seq: string | null; last_msg_id: string | null; pin_seq: string; settings_seq: string; roster_seq: string }[]>`
          SELECT seq_head::text, last_seq::text, last_msg_id, pin_seq::text, settings_seq::text, roster_seq::text
            FROM chats WHERE id = ${chat}`)[0]!;
      const mins = async (chat: string) =>
        (await tx<{ r_min1: string; r_min1_user: string | null; r_min2: string | null }[]>`
          SELECT r_min1::text, r_min1_user, r_min2::text FROM chat_receipt_mins WHERE chat_id = ${chat}`)[0];

      // 1. Numbering: born numbered, contiguous, caller seq ignored, pointer moves.
      const g = await mk_chat("group");
      check(g.seq_head === "0", "new chat born numbered", `seq_head=${g.seq_head}`);
      await tx`INSERT INTO chat_members (chat_id, user_id, role) VALUES (${g.id}, ${A}, 'admin'), (${g.id}, ${B}, 'member'), (${g.id}, ${C}, 'member')`;
      const sent = [];
      for (let i = 0; i < 5; i++) sent.push(await send(g.id, i % 2 ? B : A));
      check(sent.map((s) => s.seq).join() === "1,2,3,4,5", "seq contiguous 1..5, caller seq ignored", sent.map((s) => s.seq).join());
      check(sent.every((s) => s.mod_seq === s.seq), "mod_seq = seq at insert");
      let h = await head(g.id);
      check(h.seq_head === "5" && h.last_seq === "5" && h.last_msg_id === sent[4]!.id, "pointer moved with the allocation", JSON.stringify(h));

      // 2. Sequential duplicate: no allocation, original seq re-selectable.
      const dup = await tx`INSERT INTO messages (id, chat_id, sender_id, body) VALUES (${sent[2]!.id}, ${g.id}, ${A}, 'dup') ON CONFLICT DO NOTHING RETURNING id`;
      const [re] = await tx<{ seq: string }[]>`SELECT seq::text FROM messages WHERE id = ${sent[2]!.id}`;
      check(dup.length === 0 && re!.seq === "3" && (await head(g.id)).seq_head === "5", "duplicate allocates nothing, returns the same seq");

      // 3. Insert already deleted: numbered, pointer not moved.
      const ghost = await send(g.id, A, { deleted: true });
      h = await head(g.id);
      check(ghost.seq === 6 && h.last_msg_id === sent[4]!.id && h.last_seq === "5", "deleted insert numbered, pointer kept");

      // 4. Pin: clock value; delete of pinned row unpins with a new pin_seq.
      await tx`UPDATE chats SET pinned_msg_id = ${sent[3]!.id} WHERE id = ${g.id}`;
      h = await head(g.id);
      check(h.pin_seq === "7" && h.seq_head === "7", "pin takes a clock value", `pin_seq=${h.pin_seq}`);
      await tx`UPDATE chats SET pinned_msg_id = ${sent[3]!.id} WHERE id = ${g.id}`;
      check((await head(g.id)).seq_head === "7", "re-pinning the same row allocates nothing");

      // 5. Delete the newest: mod_seq bump + pointer rewind.
      await tx`UPDATE messages SET deleted_at = now() WHERE id = ${sent[4]!.id}`;
      const [d5] = await tx<{ mod_seq: string }[]>`SELECT mod_seq::text FROM messages WHERE id = ${sent[4]!.id}`;
      h = await head(g.id);
      check(d5!.mod_seq === "8" && h.last_msg_id === sent[3]!.id && h.last_seq === "4", "delete bumps mod_seq and rewinds the pointer", JSON.stringify({ mod: d5!.mod_seq, ...h }));
      await tx`UPDATE messages SET deleted_at = now() WHERE id = ${sent[3]!.id}`;
      h = await head(g.id);
      const [d4] = await tx<{ mod_seq: string }[]>`SELECT mod_seq::text FROM messages WHERE id = ${sent[3]!.id}`;
      const [pin] = await tx<{ pinned_msg_id: string | null }[]>`SELECT pinned_msg_id FROM chats WHERE id = ${g.id}`;
      check(d4!.mod_seq === "9" && pin!.pinned_msg_id === null && h.pin_seq === "10" && h.last_seq === "3",
        "deleting the pinned row unpins with a new pin_seq", JSON.stringify({ mod: d4!.mod_seq, ...h }));
      await tx`UPDATE messages SET deleted_at = now() WHERE id = ${sent[3]!.id}`;
      check((await head(g.id)).seq_head === "10", "a second delete allocates nothing");

      // 6. Bulk delete path (§3.3.1): amigo.bulk_alloc + one amigo_alloc(n).
      const b1 = await send(g.id, A), b2 = await send(g.id, B);
      await tx`SET LOCAL amigo.bulk_alloc = 'on'`;
      const [{ top }] = await tx<{ top: string }[]>`SELECT amigo_alloc(${g.id}, 2, NULL)::text AS top`;
      const base = Number(top) - 2;
      await tx`UPDATE messages m SET deleted_at = now(), mod_seq = ${base} + x.rn
                 FROM unnest(${tx.array([b1.id, b2.id])}::uuid[]) WITH ORDINALITY x(id, rn)
                WHERE m.id = x.id AND m.chat_id = ${g.id} AND m.deleted_at IS NULL`;
      await tx`SET LOCAL amigo.bulk_alloc = 'off'`;
      const bm = await tx<{ mod_seq: string }[]>`SELECT mod_seq::text FROM messages WHERE id IN (${b1.id}, ${b2.id}) ORDER BY mod_seq`;
      h = await head(g.id);
      check(bm.map((r) => r.mod_seq).join() === `${base + 1},${base + 2}` && h.last_seq === "3",
        "bulk delete: one allocation, distinct mod_seqs, pointer rewound", `${bm.map((r) => r.mod_seq).join()} last=${h.last_seq}`);

      // 7. System rows bump settings / roster versions.
      const sys = await send(g.id, null, { type: "system", meta: { action: "add", members: [C] } });
      const sys2 = await send(g.id, null, { type: "system", meta: { action: "chat_details:update" } });
      h = await head(g.id);
      check(h.roster_seq === String(sys.seq) && h.settings_seq === String(sys2.seq), "system rows bump roster_seq / settings_seq", JSON.stringify(h));

      // 8. Group leave of the lowest member raises the mins.
      const H = Number((await head(g.id)).seq_head);
      await tx`UPDATE chat_members SET read_seq = ${H}, delivered_seq = ${H} WHERE chat_id = ${g.id} AND user_id IN (${A}, ${B})`;
      await tx`UPDATE chat_members SET read_seq = 2, delivered_seq = 2 WHERE chat_id = ${g.id} AND user_id = ${C}`;
      await tx`SELECT amigo_refresh_min_wm(${g.id})`;
      const before = await mins(g.id);
      await tx`UPDATE chat_members SET status = 'left' WHERE chat_id = ${g.id} AND user_id = ${C}`;
      const after = await mins(g.id);
      const [cl] = await tx<{ left_seq: string | null }[]>`SELECT left_seq::text FROM chat_members WHERE chat_id = ${g.id} AND user_id = ${C}`;
      check(before?.r_min1 === "2" && before.r_min1_user === C && Number(after?.r_min1) === H,
        "group leave of the lowest member raises the mins", `${before?.r_min1} → ${after?.r_min1}`);
      check(cl!.left_seq === String(H), "leave sets left_seq = head", `left_seq=${cl!.left_seq}`);

      // 9. Fresh join (re-activate) floors at head; others_read for the lowest holder.
      await tx`UPDATE chat_members SET status = 'active' WHERE chat_id = ${g.id} AND user_id = ${C}`;
      const [cj] = await tx<{ joined_seq: string; read_seq: string; left_seq: string | null }[]>`
        SELECT joined_seq::text, read_seq::text, left_seq::text FROM chat_members WHERE chat_id = ${g.id} AND user_id = ${C}`;
      check(cj!.joined_seq === String(H) && cj!.read_seq === String(H) && cj!.left_seq === null, "rejoin floors joined/read at head", JSON.stringify(cj));

      // 10. Account-delete ghost row excluded from the mins.
      // (joined_seq too: the mins count GREATEST(read_seq, joined_seq))
      await tx`UPDATE chat_members SET read_seq = 1, joined_seq = 0 WHERE chat_id = ${g.id} AND user_id = ${C}`;
      await tx`SELECT amigo_refresh_min_wm(${g.id})`;
      const pre_ghost = await mins(g.id);
      await tx`DELETE FROM users WHERE id = ${C}`;   // FK ON DELETE SET NULL → user_id NULL row
      const ghost_m = await mins(g.id);
      check(pre_ghost?.r_min1 === "1" && pre_ghost.r_min1_user === C && Number(ghost_m?.r_min1) === H && ghost_m?.r_min1_user !== null,
        "account-delete ghost row excluded from the mins", `${pre_ghost?.r_min1} → ${ghost_m?.r_min1}`);

      // 11. DM hide → send → revive ⇒ recipient unread = 1 and sender others_read_seq < s.
      const dm = await mk_chat("dm");
      await tx`INSERT INTO chat_members (chat_id, user_id) VALUES (${dm.id}, ${A}), (${dm.id}, ${B})`;
      const m1 = await send(dm.id, A);
      await tx`UPDATE chat_members SET read_seq = ${m1.seq}, delivered_seq = ${m1.seq} WHERE chat_id = ${dm.id}`;
      await tx`UPDATE chat_members SET removed_at = now() WHERE chat_id = ${dm.id} AND user_id = ${B}`; // B hides the DM
      const m2 = await send(dm.id, A);
      await tx`UPDATE chat_members SET removed_at = NULL WHERE chat_id = ${dm.id} AND user_id = ${B}`;  // revive (not a join)
      const [ub] = await derived_unread(tx, B, { chat_ids: [dm.id] });
      const [oa] = await others_watermarks(tx, A, [dm.id]);
      check(ub?.unread === 1, "DM hide → send → revive: recipient unread = 1", `unread=${ub?.unread}`);
      check(oa !== undefined && oa.others_read_seq < m2.seq!, "DM revive: sender others_read_seq < s", `others_read=${oa?.others_read_seq} s=${m2.seq}`);

      // 12. Clear replayed late with its original upto_seq hides nothing newer.
      const c1 = await send(dm.id, A);                      // tap "clear" happens here (upto = c1.seq)
      const c2 = await send(dm.id, A);                      // arrives after the tap
      const cr = await apply_clear(tx, B, dm.id, c1.seq);   // the replay
      const [after_clear] = await derived_unread(tx, B, { chat_ids: [dm.id] });
      check(cr?.cleared_seq === c1.seq && after_clear?.unread === 1,
        "clear replay with upto_seq hides nothing newer", `cleared_seq=${cr?.cleared_seq} unread=${after_clear?.unread} (newer seq ${c2.seq})`);

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) { fail("active tests aborted", (e as Error).message); return; }
  }
  console.log("  (rolled back — nothing was written)");
}

// ── Concurrency (committed scratch chat) ────────────────────────────────────

async function concurrency_test(url: string) {
  console.log("\n▶ concurrency (committed scratch chat, deleted afterwards)");
  const P = 4, N = 25;
  const pools = Array.from({ length: P }, () => postgres(url, { max: 1, onnotice: () => {} }));
  const admin = pools[0]!;
  const [{ id: chat }] = await admin<{ id: string }[]>`
    INSERT INTO chats (type, title) VALUES ('group', '__sync_v2_verify__') RETURNING id`;
  try {
    const dup_id = crypto.randomUUID();
    const work = pools.map(async (p, w) => {
      const out: { id: string; seq: number | null }[] = [];
      for (let i = 0; i < N; i++) {
        const id = i === 0 ? dup_id : crypto.randomUUID();     // every worker races the same first id
        const r = await p<{ seq: string }[]>`
          INSERT INTO messages (id, chat_id, body) VALUES (${id}, ${chat}, ${`w${w}-${i}`})
          ON CONFLICT (id) DO NOTHING RETURNING seq::text`;
        out.push({ id, seq: r[0] ? Number(r[0].seq) : null });
      }
      return out;
    });
    const all = (await Promise.all(work)).flat();
    const [{ dseq }] = await admin<{ dseq: string }[]>`SELECT seq::text AS dseq FROM messages WHERE id = ${dup_id}`;
    const rows = await admin<{ seq: string }[]>`SELECT seq::text FROM messages WHERE chat_id = ${chat} ORDER BY messages.seq`;
    const seqs = rows.map((r) => Number(r.seq));
    const [{ seq_head }] = await admin<{ seq_head: string }[]>`SELECT seq_head::text FROM chats WHERE id = ${chat}`;
    const distinct = new Set(seqs).size === seqs.length;
    const expected_rows = P * (N - 1) + 1;
    // messages_bi re-checks the id under the chat lock, so even a concurrent
    // duplicate burns nothing and cannot point last_seq at a missing row.
    const burned = Number(seq_head) - seqs.length;
    const [ptr] = await admin<{ ok: boolean }[]>`
      SELECT c.last_seq = m.seq AS ok FROM chats c JOIN messages m ON m.id = c.last_msg_id WHERE c.id = ${chat}`;
    check(seqs.length === expected_rows && distinct, "concurrent inserts get distinct seqs", `${seqs.length} rows, distinct=${distinct}`);
    check(burned === 0, "concurrent duplicates burn no value", `burned=${burned}`);
    check(ptr?.ok === true, "pointer names a real row after the race (last_seq = seq(last_msg_id))");
    const dup_winner = all.filter((r) => r.id === dup_id && r.seq !== null);
    check(dup_winner.length === 1 && dup_winner[0]!.seq === Number(dseq), "duplicate re-select returns the winner's seq", `seq=${dseq}`);
    check(seqs[seqs.length - 1]! <= Number(seq_head), "max seq <= seq_head");
  } finally {
    await admin`DELETE FROM chats WHERE id = ${chat}`;
    await Promise.all(pools.map((p) => p.end()));
  }
}

// ── main ────────────────────────────────────────────────────────────────────

const sql = open_sql(1);
try {
  console.log(`sync-v2-verify against ${new URL(process.env.DB_URL!).host}`);
  await readonly_checks(sql);
  if (opt("redis") !== undefined || flag("redis")) await redis_histogram(sql, Number(opt("redis")) || 200);
  if (!flag("no-active")) await active_tests(sql);
  if (flag("concurrency")) await concurrency_test(process.env.DB_URL!);
} catch (e) {
  fail("verify crashed", (e as Error).stack ?? String(e));
} finally {
  await sql.end();
}
console.log(failures === 0 ? "\n✅ all checks passed" : `\n✖ ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
