// =============================================================================
// Load & accuracy test tool — I/O (routes: routes/load-test.routes.ts)
// =============================================================================
// Every write here goes through the SAME services the app's own requests use
// (create_dm, create_group, add_new_member, remove_member, leave_group,
// dm_delete_status, socket_message_handler for sends, handle_conv_join /
// handle_message_status_ack for receipts): the tool measures the real paths,
// it does not reimplement them. Rules and math: load-test-core.ts.
//
// Safety (the route layer has already checked LOAD_TEST_ENABLED and the live
// admin / sub_admin role):
//   - the server acts only as a TEST user (phone +99900…) or as the caller;
//     any other user id in a request → 403 not_a_test_user, nothing done;
//   - sends / receipts / member changes only touch TEST chats (a group titled
//     `LT·…`, or a DM whose members are all test users or the caller); any
//     other chat is refused per item (code 403, not_a_test_chat);
//   - no hard deletes: cleanup leaves / hides chats with the normal services
//     and purges only test users' offline queues.
// =============================================================================
import { randomBytes } from "node:crypto";
import { pg_client } from "@/config/db";
import { redis } from "@/config/redis";
import { create_dm, dm_delete_status } from "@/services/chat-dm.service";
import { add_new_member, create_group, leave_group, remove_member } from "@/services/chat-group.service";
import { get_chat_list } from "@/services/chat.services";
import { sync_v2_flags } from "@/services/app-settings.service";
import { socket_message_handler } from "@/sockets/socket.handlers";
import { handle_conv_join, handle_message_status_ack } from "@/sockets/socket.service";
import { redis_entries_key, redis_return_meta_key } from "@/cache-management/pending-store-core";
import { hash_pin } from "@/utils/general.utils";
import type { ChatMessagePayload, WSMessage } from "@/types/socket.types";
import { note_test_users, refresh_test_users } from "./load-test-registry";
import {
  CAPS,
  TEST_GROUP_PREFIX,
  TEST_PHONE_PREFIX,
  body_like_for,
  body_regex_for,
  build_verify_chat,
  format_body,
  group_title,
  not_allowed_ids,
  pick_random,
  random_tag,
  run_keyed_pool,
  run_pool,
  seq_span,
  send_stats,
  test_name,
  test_phone,
  type SendItem,
  type SendResult,
  type StreamAggRow,
  type VerifyChat,
} from "./load-test-core";

const sql = pg_client;
const PHONE_LIKE = TEST_PHONE_PREFIX + "%";
const GROUP_LIKE = TEST_GROUP_PREFIX + "%";
// Exact test-phone shape (the LIKE above is the cheap prefilter).
const PHONE_REGEX = "^\\+99900[0-9]{7}$";

type Res<T = unknown> = { success: boolean; code: number; message: string; data: T | null; reason?: string };

const ok_res = <T>(data: T, message = "OK"): Res<T> => ({ success: true, code: 200, message, data });
const fail = (code: number, message: string, reason: string, data: unknown = null): Res<any> =>
  ({ success: false, code, message, data, reason });

const not_a_test_user = (ids: string[]) =>
  fail(403, "Only test users (+99900…) or yourself can be acted as", "not_a_test_user", { user_ids: ids });

const err_msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const round_ms = (ms: number) => Math.round(ms * 10) / 10;

// ── lookups ────────────────────────────────────────────────────────────────

/** Of `ids`, the ones that are test users. */
const test_users_among = async (ids: string[]): Promise<Set<string>> => {
  if (ids.length === 0) return new Set();
  const rows = await sql<{ id: string }[]>`
    SELECT id::text AS id FROM users
     WHERE id = ANY(${sql.array(ids)}::uuid[]) AND phone LIKE ${PHONE_LIKE} AND phone ~ ${PHONE_REGEX}`;
  return new Set(rows.map((r) => r.id));
};

const all_test_user_ids = async (): Promise<string[]> => {
  const rows = await sql<{ id: string }[]>`
    SELECT id::text AS id FROM users WHERE phone LIKE ${PHONE_LIKE} AND phone ~ ${PHONE_REGEX} ORDER BY phone`;
  return rows.map((r) => r.id);
};

type TestChat = { id: string; type: string; title: string | null; owner_id: string | null };

/**
 * Of `chat_ids`, the TEST chats (live): groups titled `LT·…`, and DMs whose
 * members are all test users or the caller (at least one test user).
 */
const test_chats_among = async (chat_ids: string[], caller_id: string): Promise<Map<string, TestChat>> => {
  if (chat_ids.length === 0) return new Map();
  const rows = await sql<(TestChat & { all_ok: boolean | null; any_test: boolean | null })[]>`
    SELECT c.id::text AS id, c.type, c.title, c.owner_id::text AS owner_id,
           bool_and(u.phone LIKE ${PHONE_LIKE} OR m.user_id = ${caller_id}::uuid) FILTER (WHERE m.user_id IS NOT NULL) AS all_ok,
           bool_or(u.phone LIKE ${PHONE_LIKE}) AS any_test
      FROM chats c
      LEFT JOIN chat_members m ON m.chat_id = c.id
      LEFT JOIN users u ON u.id = m.user_id
     WHERE c.id = ANY(${sql.array(chat_ids)}::uuid[]) AND c.deleted_at IS NULL
     GROUP BY c.id`;
  const out = new Map<string, TestChat>();
  for (const r of rows) {
    const is_group = r.type === "group" && typeof r.title === "string" && r.title.startsWith(TEST_GROUP_PREFIX);
    const is_dm = r.type === "dm" && r.all_ok === true && r.any_test === true;
    if (is_group || is_dm) out.set(r.id, { id: r.id, type: r.type, title: r.title, owner_id: r.owner_id });
  }
  return out;
};

const active_members = async (chat_id: string): Promise<{ user_id: string; is_test: boolean; delivered_seq: number }[]> => {
  const rows = await sql<{ user_id: string; is_test: boolean; delivered_seq: string | number }[]>`
    SELECT m.user_id::text AS user_id, (u.phone LIKE ${PHONE_LIKE}) AS is_test, m.delivered_seq
      FROM chat_members m JOIN users u ON u.id = m.user_id
     WHERE m.chat_id = ${chat_id} AND m.removed_at IS NULL AND m.status = 'active'`;
  return rows.map((r) => ({ user_id: r.user_id, is_test: r.is_test === true, delivered_seq: Number(r.delivered_seq ?? 0) }));
};

// ── 1. status ──────────────────────────────────────────────────────────────

export const lt_status = async () => {
  const [r] = await sql<{ users: number; groups: number; dms: number }[]>`
    SELECT
      (SELECT count(*)::int FROM users WHERE phone LIKE ${PHONE_LIKE}) AS users,
      (SELECT count(*)::int FROM chats WHERE type = 'group' AND deleted_at IS NULL AND title LIKE ${GROUP_LIKE}) AS groups,
      (SELECT count(DISTINCT c.id)::int FROM chats c
         JOIN chat_members m ON m.chat_id = c.id
         JOIN users u ON u.id = m.user_id
        WHERE c.type = 'dm' AND c.deleted_at IS NULL AND u.phone LIKE ${PHONE_LIKE}) AS dms`;
  return ok_res({
    enabled: true,
    test_users: r?.users ?? 0,
    test_groups: r?.groups ?? 0,
    test_dms: r?.dms ?? 0,
    server_time: new Date().toISOString(),
    // Additive: which sync mode the numbers were produced under.
    sync_v2: sync_v2_flags().mode,
  });
};

// ── 2. create users ────────────────────────────────────────────────────────

export const lt_create_users = async (count: number) => {
  // An unusable login PIN: the bcrypt hash of a random 32-byte secret nobody
  // holds. The login screen sees has_pin = true and asks for a PIN; no
  // 4-digit PIN can match. (A NULL PIN would make the app fall back to OTP;
  // +999 numbers cannot receive one, but dev's fixed OTP could.) One hash
  // per call, shared: it protects nothing, it only has to never match.
  const unusable_pin_hash = await hash_pin(randomBytes(32).toString("hex"));

  const result = await sql.begin(async (tx) => {
    // Serialise numbering across concurrent calls / workers.
    await tx`SELECT pg_advisory_xact_lock(hashtext('amigo_load_test_users'))`;
    const [cur] = await tx<{ total: number; max_n: number | null }[]>`
      SELECT count(*)::int AS total,
             max(substr(phone, ${TEST_PHONE_PREFIX.length + 1})::int) FILTER (WHERE phone ~ ${PHONE_REGEX}) AS max_n
        FROM users WHERE phone LIKE ${PHONE_LIKE}`;
    const total = cur?.total ?? 0;
    if (total + count > CAPS.total_test_users) {
      return { capped: true as const, total };
    }
    const start = (cur?.max_n ?? 0) + 1;
    const names: string[] = [];
    const phones: string[] = [];
    for (let i = 0; i < count; i++) {
      names.push(test_name(start + i));
      phones.push(test_phone(start + i));
    }
    const created = await tx<{ id: string; name: string; phone: string }[]>`
      INSERT INTO users (name, phone, role, password_pin_hash, must_reset_pin)
      SELECT n, p, 'user', ${unusable_pin_hash}, false
        FROM unnest(${tx.array(names)}::text[], ${tx.array(phones)}::text[]) AS t(n, p)
      RETURNING id::text AS id, name, phone`;
    return { capped: false as const, created, total: total + created.length };
  });

  if (result.capped) {
    return fail(400, `At most ${CAPS.total_test_users} test users (there are ${result.total})`, "cap_exceeded", { total: result.total });
  }
  // Visible to this worker's pending-store filter at once; siblings pick
  // them up on their next refresh.
  note_test_users(result.created.map((u) => u.id));
  const created = [...result.created].sort((a, b) => a.phone.localeCompare(b.phone));
  return ok_res({ created, total: result.total }, `Created ${created.length} test user(s)`);
};

// ── 3. list users ──────────────────────────────────────────────────────────

export const lt_list_users = async (limit: number, offset: number) => {
  const [users, [t]] = await Promise.all([
    sql<{ id: string; name: string; phone: string }[]>`
      SELECT id::text AS id, name, phone FROM users WHERE phone LIKE ${PHONE_LIKE}
       ORDER BY phone LIMIT ${limit} OFFSET ${offset}`,
    sql<{ total: number }[]>`SELECT count(*)::int AS total FROM users WHERE phone LIKE ${PHONE_LIKE}`,
  ]);
  return ok_res({ users, total: t?.total ?? 0 });
};

// ── 4. DMs ─────────────────────────────────────────────────────────────────

export const lt_create_dms = async (caller_id: string, pairs: [string, string][]) => {
  const ids = [...new Set(pairs.flat())];
  const bad_ids = not_allowed_ids(ids, caller_id, await test_users_among(ids));
  if (bad_ids.length > 0) return not_a_test_user(bad_ids);

  const chats = await run_pool(pairs, 8, async ([a, b]) => {
    try {
      // create_dm acting as `a` (its sender side), exactly the app's
      // POST /chat/dm/create-dm/:b.
      const r = await create_dm(a, b);
      const chat_id = (r.data as { id?: string } | undefined)?.id ?? null;
      return {
        chat_id, a, b, ok: r.success && !!chat_id,
        existing: (r.data as { existing?: boolean } | undefined)?.existing === true,
        ...(r.success ? {} : { error: r.message }),
      };
    } catch (e) {
      return { chat_id: null, a, b, ok: false, existing: false, error: err_msg(e) };
    }
  });
  return ok_res({ chats });
};

// ── 5. groups ──────────────────────────────────────────────────────────────

export const lt_create_groups = async (
  caller_id: string,
  opts: { count: number; members_per_group: number; include_me: boolean; title_prefix: string | null },
) => {
  const pool = await all_test_user_ids();
  if (pool.length < opts.members_per_group) {
    return fail(400, `Only ${pool.length} test user(s) exist; create more first`, "not_enough_test_users", { test_users: pool.length });
  }
  const tag = opts.title_prefix ?? random_tag();
  const indexes = Array.from({ length: opts.count }, (_, i) => i + 1);
  const groups = await run_pool(indexes, 4, async (i) => {
    const title = group_title(tag, i, opts.count);
    const members = pick_random(pool, opts.members_per_group);
    // include_me: the caller creates (owner); else a random member does.
    const creator = opts.include_me ? caller_id : members[0];
    const others = members.filter((m) => m !== creator);
    try {
      const r = await create_group(creator, title, others);
      const chat_id = (r.data as { id?: string } | undefined)?.id ?? null;
      return {
        chat_id, title,
        member_ids: [creator, ...others],
        owner_id: creator,
        ok: r.success && !!chat_id,
        ...(r.success ? {} : { error: r.message }),
      };
    } catch (e) {
      return { chat_id: null, title, member_ids: [creator, ...others], owner_id: creator, ok: false, error: err_msg(e) };
    }
  });
  return ok_res({ groups });
};

// ── 6. chats ───────────────────────────────────────────────────────────────

export const lt_list_chats = async (caller_id: string) => {
  const [groups, dm_rows] = await Promise.all([
    sql<{ chat_id: string; title: string; member_count: number; i_am_member: boolean; owner_id: string | null }[]>`
      SELECT c.id::text AS chat_id, c.title, c.owner_id::text AS owner_id,
             (SELECT count(*)::int FROM chat_members m
               WHERE m.chat_id = c.id AND m.removed_at IS NULL AND m.status = 'active') AS member_count,
             EXISTS (SELECT 1 FROM chat_members m
                      WHERE m.chat_id = c.id AND m.user_id = ${caller_id}::uuid
                        AND m.removed_at IS NULL AND m.status = 'active') AS i_am_member
        FROM chats c
       WHERE c.type = 'group' AND c.deleted_at IS NULL AND c.title LIKE ${GROUP_LIKE}
       ORDER BY c.created_at, c.id`,
    sql<{ chat_id: string; members: { id: string; name: string; hidden: boolean }[] }[]>`
      SELECT c.id::text AS chat_id,
             json_agg(json_build_object('id', m.user_id, 'name', u.name, 'hidden', m.removed_at IS NOT NULL)
                      ORDER BY m.user_id) AS members
        FROM chats c
        JOIN chat_members m ON m.chat_id = c.id
        JOIN users u ON u.id = m.user_id
       WHERE c.type = 'dm' AND c.deleted_at IS NULL
         AND c.id IN (SELECT m2.chat_id FROM chat_members m2 JOIN users u2 ON u2.id = m2.user_id
                       WHERE u2.phone LIKE ${PHONE_LIKE})
       GROUP BY c.id, c.created_at
      HAVING bool_and(u.phone LIKE ${PHONE_LIKE} OR m.user_id = ${caller_id}::uuid)
       ORDER BY c.created_at, c.id`,
  ]);
  const dms = dm_rows.map((r) => {
    const [a, b] = r.members;
    const me = r.members.find((m) => m.id === caller_id);
    // "other" is relative to the caller; for a DM between two test users it
    // is the second member (a / b carry both).
    const other = me ? r.members.find((m) => m.id !== caller_id) ?? b : b ?? a;
    return {
      chat_id: r.chat_id,
      other_id: other?.id ?? null,
      other_name: other?.name ?? null,
      a: a?.id ?? null,
      b: b?.id ?? null,
      i_am_member: !!me && !me.hidden,
    };
  });
  return ok_res({ groups, dms });
};

// ── 7. members ─────────────────────────────────────────────────────────────

export const lt_change_members = async (caller_id: string, opts: { chat_ids: string[]; add: number; remove: number }) => {
  const [chats, pool] = await Promise.all([test_chats_among(opts.chat_ids, caller_id), all_test_user_ids()]);
  const results = [];
  for (const chat_id of opts.chat_ids) {
    const chat = chats.get(chat_id);
    const added: string[] = [];
    const removed: string[] = [];
    const errors: string[] = [];
    if (!chat || chat.type !== "group") {
      results.push({ chat_id, added, removed, errors: ["not_a_test_group"] });
      continue;
    }
    // Actor = the group's owner: the caller when they own it, else the owner
    // when that is a test user (a group created with include_me=false, or one
    // the caller left). The services do no permission check of their own;
    // owner is what the app's route would demand (caps.canManageMembers).
    const actor = chat.owner_id === caller_id
      ? caller_id
      : chat.owner_id && (await test_users_among([chat.owner_id])).has(chat.owner_id)
        ? chat.owner_id
        : null;
    if (!actor) {
      results.push({ chat_id, added, removed, errors: ["owner_is_not_you_or_a_test_user"] });
      continue;
    }
    try {
      const members = await active_members(chat_id);
      const active = new Set(members.map((m) => m.user_id));
      const removable = members.filter((m) => m.is_test && m.user_id !== actor && m.user_id !== chat.owner_id).map((m) => m.user_id);
      const to_remove = pick_random(removable, opts.remove);
      if (to_remove.length < opts.remove) errors.push(`only ${to_remove.length} removable test member(s)`);
      const room = Math.max(0, CAPS.members_per_group - (active.size - to_remove.length));
      const addable = pool.filter((id) => !active.has(id));
      let add_n = Math.min(opts.add, addable.length);
      if (add_n > room) {
        errors.push(`capped at ${CAPS.members_per_group} members`);
        add_n = room;
      } else if (add_n < opts.add) {
        errors.push(`only ${addable.length} test user(s) not in the group`);
      }
      const to_add = pick_random(addable, add_n);

      const rm = await run_pool(to_remove, 8, async (uid) => {
        try {
          const r = await remove_member(chat_id, uid, actor);
          return r.success ? uid : (errors.push(`remove ${uid}: ${r.message}`), null);
        } catch (e) {
          errors.push(`remove ${uid}: ${err_msg(e)}`);
          return null;
        }
      });
      for (const id of rm) if (id) removed.push(id);

      if (to_add.length > 0) {
        const r = await add_new_member(chat_id, to_add, "member", actor);
        if (r.success) {
          const d = r.data as { inserted?: { user_id: string | null }[] } | undefined;
          const got = new Set((d?.inserted ?? []).map((x) => x.user_id).filter((x): x is string => !!x));
          for (const id of to_add) if (got.has(id)) added.push(id);
        } else {
          errors.push(`add: ${r.message}`);
        }
      }
    } catch (e) {
      errors.push(err_msg(e));
    }
    results.push({ chat_id, added, removed, errors });
  }
  return ok_res({ results });
};

// ── 8. send ────────────────────────────────────────────────────────────────

export const lt_send = async (caller_id: string, opts: { run: string; sends: SendItem[]; concurrency: number }) => {
  const sender_ids = [...new Set(opts.sends.map((s) => s.sender_id))];
  const bad_ids = not_allowed_ids(sender_ids, caller_id, await test_users_among(sender_ids));
  if (bad_ids.length > 0) return not_a_test_user(bad_ids);

  const chat_ids = [...new Set(opts.sends.map((s) => s.chat_id))];
  const [chats, name_rows] = await Promise.all([
    test_chats_among(chat_ids, caller_id),
    sql<{ id: string; name: string }[]>`SELECT id::text AS id, name FROM users WHERE id = ANY(${sql.array(sender_ids)}::uuid[])`,
  ]);
  const names = new Map(name_rows.map((r) => [r.id, r.name]));

  const t0 = performance.now();
  // Per stream (chat, sender) strictly in request order, streams concurrent:
  // one stream behaves like one phone sending (see run_keyed_pool).
  const results = await run_keyed_pool(opts.sends, (s) => `${s.chat_id}|${s.sender_id}`, opts.concurrency, async (s): Promise<SendResult & { error?: string }> => {
    const id = Bun.randomUUIDv7();
    if (!chats.has(s.chat_id)) {
      return { chat_id: s.chat_id, sender_id: s.sender_id, n: s.n, id, ok: false, code: 403, ms: 0, error: "not_a_test_chat" };
    }
    const payload: ChatMessagePayload = {
      id,
      conv_id: s.chat_id,
      sender_id: s.sender_id,
      msg_type: "text",
      body: format_body(s.n, opts.run, s.N),
      replied_to: null,
      sent_at: new Date().toISOString() as unknown as Date,
    };
    const frame: WSMessage = { type: "message:new", payload, ws_timestamp: new Date() };
    const start = performance.now();
    try {
      // The POST /chat/poll/send-message path, minus the poll-lease touch:
      // a test user is not a poller and must stay "offline" for fan-out.
      const handled = await socket_message_handler({ user_id: s.sender_id, user_name: names.get(s.sender_id) ?? "" }, frame);
      const ms = round_ms(performance.now() - start);
      const ack = handled?.data?.sent_ack;
      const ok = handled?.success === true && ack?.is_sent === true;
      const code = ok ? 200 : (handled?.code && handled.code >= 400 ? handled.code : ack?.error_code ?? 500);
      const seq = (ack as { seq?: unknown } | undefined)?.seq;
      return {
        chat_id: s.chat_id, sender_id: s.sender_id, n: s.n, id, ok, code, ms,
        ...(typeof seq === "number" ? { seq } : {}),
        ...(ok ? {} : { error: handled?.message ?? "send failed" }),
      };
    } catch (e) {
      return { chat_id: s.chat_id, sender_id: s.sender_id, n: s.n, id, ok: false, code: 500, ms: round_ms(performance.now() - start), error: err_msg(e) };
    }
  });
  const wall_ms = round_ms(performance.now() - t0);
  return ok_res({ results, stats: send_stats(results, wall_ms) });
};

// ── 9. receipts ────────────────────────────────────────────────────────────

// Delivered acks name message ids (the app's message:status:ack). Per user
// and chat at most this many of the newest not-yet-delivered messages, in
// chunks the size the app batches.
const DELIVERED_IDS_CAP = 500;
const ACK_CHUNK = 100;

export const lt_receipts = async (caller_id: string, opts: { chat_ids: string[]; status: "delivered" | "read" }) => {
  const chats = await test_chats_among(opts.chat_ids, caller_id);
  const results = [];
  for (const chat_id of opts.chat_ids) {
    if (!chats.has(chat_id)) {
      results.push({ chat_id, users: 0, ok: 0, failed: 0, error: "not_a_test_chat" });
      continue;
    }
    try {
      const testers = (await active_members(chat_id)).filter((m) => m.is_test);
      let ok = 0;
      let failed = 0;
      if (opts.status === "read") {
        // The newest NON-system message is what the app sends as its read
        // watermark (conversation:join).
        const [newest] = await sql<{ id: string; seq: string | number | null }[]>`
          SELECT id::text AS id, seq FROM messages
           WHERE chat_id = ${chat_id} AND deleted_at IS NULL AND type <> 'system'
           ORDER BY seq DESC NULLS LAST, created_at DESC LIMIT 1`;
        if (newest) {
          const read_seq = newest.seq === null ? undefined : Number(newest.seq);
          const outcomes = await run_pool(testers, 16, async (m) => {
            try {
              const r = await handle_conv_join(
                { conv_id: chat_id, user_id: m.user_id, last_read_msg_id: newest.id, ...(read_seq !== undefined ? { read_seq } : {}) },
                new Date(),
              );
              return r.success;
            } catch {
              return false;
            }
          });
          for (const o of outcomes) o ? ok++ : failed++;
        } else {
          ok = testers.length; // nothing to read
        }
      } else {
        const recent = await sql<{ id: string; sender_id: string | null; seq: string | number | null }[]>`
          SELECT id::text AS id, sender_id::text AS sender_id, seq FROM messages
           WHERE chat_id = ${chat_id} AND deleted_at IS NULL AND type <> 'system' AND sender_id IS NOT NULL
           ORDER BY seq DESC NULLS LAST, created_at DESC LIMIT ${DELIVERED_IDS_CAP * 2}`;
        const outcomes = await run_pool(testers, 16, async (m) => {
          const ids = recent
            .filter((x) => x.sender_id !== m.user_id && (x.seq === null || Number(x.seq) > m.delivered_seq))
            .slice(0, DELIVERED_IDS_CAP)
            .map((x) => x.id)
            .reverse();
          try {
            for (let i = 0; i < ids.length; i += ACK_CHUNK) {
              const at = new Date();
              const r = await handle_message_status_ack(
                { recipient_id: m.user_id, at, acks: [{ chat_id, msg_ids: ids.slice(i, i + ACK_CHUNK), status: ["delivered"] }] },
                m.user_id,
                at,
              );
              if (!r.success) return false;
            }
            return true;
          } catch {
            return false;
          }
        });
        for (const o of outcomes) o ? ok++ : failed++;
      }
      results.push({ chat_id, users: testers.length, ok, failed });
    } catch (e) {
      results.push({ chat_id, users: 0, ok: 0, failed: 0, error: err_msg(e) });
    }
  }
  return ok_res({ results });
};

// ── 10. verify ─────────────────────────────────────────────────────────────

export const lt_verify = async (caller_id: string, opts: { run: string; chat_ids: string[] }) => {
  const chats = await test_chats_among(opts.chat_ids, caller_id);
  const ids = opts.chat_ids.filter((id) => chats.has(id));
  const like = body_like_for(opts.run);
  const re = body_regex_for(opts.run);

  // Per (chat, sender): counts, n range, declared N, adjacent decreases of n
  // in seq order (created_at when unnumbered), the checksum partial sum and
  // the seq span. chat_id = ANY(...) rides the chat_id indexes; the LIKE /
  // regex then only scans those chats' rows.
  const agg = ids.length === 0 ? [] : await sql<StreamAggRow[]>`
    WITH r AS (
      SELECT id, chat_id, sender_id, seq, created_at,
             substring(body FROM '^([0-9]+)')::bigint AS n,
             substring(body FROM '^[0-9]+/([0-9]+) ')::bigint AS big_n
        FROM messages
       WHERE chat_id = ANY(${sql.array(ids)}::uuid[])
         AND deleted_at IS NULL
         AND body LIKE ${like}
         AND body ~ ${re}
    ), o AS (
      SELECT *, lag(n) OVER (PARTITION BY chat_id, sender_id ORDER BY seq NULLS LAST, created_at, id) AS prev_n
        FROM r
    )
    SELECT chat_id::text AS chat_id, sender_id::text AS sender_id,
           count(*)::int AS cnt,
           count(DISTINCT n)::int AS distinct_n,
           min(n)::text AS min_n, max(n)::text AS max_n, max(big_n)::text AS declared_n,
           (count(*) FILTER (WHERE prev_n IS NOT NULL AND n < prev_n))::int AS order_violations,
           sum(('x' || substr(md5(id::text), 1, 8))::bit(32)::bigint)::text AS ck_sum,
           min(seq)::text AS min_seq, max(seq)::text AS max_seq
      FROM o
     GROUP BY chat_id, sender_id`;

  const by_chat = new Map<string, StreamAggRow[]>();
  for (const r of agg) {
    const list = by_chat.get(r.chat_id) ?? [];
    list.push(r);
    by_chat.set(r.chat_id, list);
  }

  // seq holes: ALL rows of the chat (any body, deleted ones too — a deleted
  // row keeps its seq) inside the run's span. mods_in_range (additive): clock
  // values a delete took inside the span (mod_seq <> seq), which are not rows.
  const spans = ids
    .map((id) => ({ id, span: seq_span(by_chat.get(id) ?? []) }))
    .filter((x): x is { id: string; span: { min: number; max: number } } => x.span !== null);
  const in_range = new Map<string, { rows: number; mods: number }>();
  if (spans.length > 0) {
    const rows = await sql<{ chat_id: string; rows: number; mods: number }[]>`
      SELECT s.chat_id::text AS chat_id,
             (SELECT count(*)::int FROM messages m WHERE m.chat_id = s.chat_id AND m.seq BETWEEN s.lo AND s.hi) AS rows,
             (SELECT count(*)::int FROM messages m WHERE m.chat_id = s.chat_id AND m.mod_seq <> m.seq
                 AND m.mod_seq BETWEEN s.lo AND s.hi) AS mods
        FROM unnest(${sql.array(spans.map((s) => s.id))}::uuid[],
                    ${sql.array(spans.map((s) => s.span.min))}::bigint[],
                    ${sql.array(spans.map((s) => s.span.max))}::bigint[]) AS s(chat_id, lo, hi)`;
    for (const r of rows) in_range.set(r.chat_id, { rows: r.rows, mods: r.mods });
  }

  // The caller's unread exactly as their chat list serves it right now
  // (derived in sync v2 'on', Redis otherwise), and their watermarks — only
  // maintained once sync v2 is past 'off' (dual-write), so null in 'off'.
  const mode = sync_v2_flags().mode;
  const [list, wm_rows] = await Promise.all([
    get_chat_list(caller_id, "all"),
    mode === "off" || ids.length === 0
      ? Promise.resolve([] as { chat_id: string; read_seq: string; delivered_seq: string }[])
      : sql<{ chat_id: string; read_seq: string; delivered_seq: string }[]>`
          SELECT chat_id::text AS chat_id, read_seq, delivered_seq FROM chat_members
           WHERE user_id = ${caller_id}::uuid AND chat_id = ANY(${sql.array(ids)}::uuid[]) AND removed_at IS NULL`,
  ]);
  const unread = new Map<string, number>();
  for (const c of (list.success ? list.data ?? [] : []) as { conversationId: string; unreadCount?: number }[]) {
    unread.set(c.conversationId, Number(c.unreadCount ?? 0));
  }
  const wm = new Map(wm_rows.map((r) => [r.chat_id, r]));

  const out: (VerifyChat & { error?: string })[] = opts.chat_ids.map((chat_id) => {
    if (!chats.has(chat_id)) {
      return {
        chat_id, total: 0, checksum: "0", streams: [], seq: null,
        my_unread: null, my_read_seq: null, my_delivered_seq: null, error: "not_a_test_chat",
      };
    }
    const w = wm.get(chat_id);
    const ir = in_range.get(chat_id);
    const v = build_verify_chat(chat_id, by_chat.get(chat_id) ?? [], {
      rows_in_range: ir?.rows ?? 0,
      my_unread: unread.has(chat_id) ? unread.get(chat_id)! : null,
      my_read_seq: w ? Number(w.read_seq) : null,
      my_delivered_seq: w ? Number(w.delivered_seq) : null,
    });
    return v.seq ? { ...v, seq: { ...v.seq, mods_in_range: ir?.mods ?? 0 } } : v;
  });
  return ok_res({ run: opts.run, chats: out, server_time: new Date().toISOString() });
};

// ── 11. cleanup ────────────────────────────────────────────────────────────

const ID_CHUNK = 500;

export const lt_cleanup = async (caller_id: string, scope: "me_out" | "purge_queues") => {
  if (scope === "me_out") {
    const errors: { chat_id: string; message: string }[] = [];
    let groups_left = 0;
    let dms_hidden = 0;
    const groups = await sql<{ chat_id: string; owner_id: string | null }[]>`
      SELECT c.id::text AS chat_id, c.owner_id::text AS owner_id
        FROM chats c JOIN chat_members m ON m.chat_id = c.id
       WHERE c.type = 'group' AND c.deleted_at IS NULL AND c.title LIKE ${GROUP_LIKE}
         AND m.user_id = ${caller_id}::uuid AND m.removed_at IS NULL AND m.status = 'active'`;
    for (const g of groups) {
      try {
        let new_owner: string | undefined;
        if (g.owner_id === caller_id) {
          // An owner must hand the group to an active member first (the
          // normal leave rule): a random test-user member.
          const successor = pick_random((await active_members(g.chat_id)).filter((m) => m.is_test && m.user_id !== caller_id), 1)[0];
          if (!successor) {
            errors.push({ chat_id: g.chat_id, message: "no test-user member to hand ownership to" });
            continue;
          }
          new_owner = successor.user_id;
        }
        const r = await leave_group(g.chat_id, caller_id, new_owner);
        if (r.success) groups_left++;
        else errors.push({ chat_id: g.chat_id, message: r.message });
      } catch (e) {
        errors.push({ chat_id: g.chat_id, message: err_msg(e) });
      }
    }
    const dms = await sql<{ chat_id: string }[]>`
      SELECT c.id::text AS chat_id
        FROM chats c JOIN chat_members m ON m.chat_id = c.id
       WHERE c.type = 'dm' AND c.deleted_at IS NULL
         AND m.user_id = ${caller_id}::uuid AND m.removed_at IS NULL
         AND EXISTS (SELECT 1 FROM chat_members o JOIN users u ON u.id = o.user_id
                      WHERE o.chat_id = c.id AND o.user_id <> ${caller_id}::uuid AND u.phone LIKE ${PHONE_LIKE})
         AND NOT EXISTS (SELECT 1 FROM chat_members o JOIN users u ON u.id = o.user_id
                          WHERE o.chat_id = c.id AND o.user_id <> ${caller_id}::uuid AND u.phone NOT LIKE ${PHONE_LIKE})`;
    for (const d of dms) {
      try {
        const r = await dm_delete_status(d.chat_id, caller_id, true);
        if (r.success) dms_hidden++;
        else errors.push({ chat_id: d.chat_id, message: r.message });
      } catch (e) {
        errors.push({ chat_id: d.chat_id, message: err_msg(e) });
      }
    }
    return ok_res({ scope, groups_left, dms_hidden, errors });
  }

  // purge_queues: offline-replay state of TEST users only. New entries are
  // no longer written for known test users (load-test-registry.ts); this
  // removes whatever predates that (or a sibling that had not refreshed yet).
  const ids = await all_test_user_ids();
  note_test_users(ids);
  let missed_ws_rows = 0;
  let redis_keys = 0;
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const del = await sql`DELETE FROM missed_ws_messages WHERE user_id = ANY(${sql.array(chunk)}::uuid[])`;
    missed_ws_rows += del.count ?? 0;
    const keys = chunk.flatMap((id) => [redis_entries_key(id), redis_return_meta_key(id), `user_unread:${id}`]);
    redis_keys += await redis.del(...keys);
  }
  await refresh_test_users();
  return ok_res({ scope, test_users: ids.length, missed_ws_rows, redis_keys });
};

