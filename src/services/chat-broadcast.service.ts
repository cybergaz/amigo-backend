import db from "@/config/db";
import { chat_model, chat_member_model } from "@/models/chat.model";
import { message_model, message_info_model, DBMessageType } from "@/models/message.model";
import { user_model } from "@/models/user.model";
import { broadcast_recipient_model, broadcast_message_copy_model } from "@/models/broadcast.model";
import { alias } from "drizzle-orm/pg-core";
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { broadcast_message } from "@/sockets/socket.handlers";
import { add_members, add_members_bulk } from "@/cache-management/conv.cache";
import { batch_set_last_message, increment_unread } from "@/cache-management/chat-meta.cache";
import { get_message_statuses_bulk } from "@/cache-management/message.cache";
import { prime_chat_type } from "@/cache-management/chat-type.cache";
import { queue_message_fcm } from "@/services/fcm-batch.service";
import { resolve_stored_sent_at } from "@/utils/message-time.utils";
import {
  BROADCAST_COPIES_MAX_IDS,
  BROADCAST_FANOUT_CONCURRENCY,
  BROADCAST_MAX_RECIPIENTS,
  LOCK_NS_BROADCAST_SENDER,
  chunk,
  derive_broadcast_copy_id,
  dm_pair_lock_key,
  dm_pair_locks_sql,
  for_each_with_concurrency,
  is_uuid,
  normalize_broadcast_title,
  normalize_recipient_ids,
  tx_timeouts_sql,
} from "@/utils/broadcast.utils";
import { ResultType } from "@/types/core.types";
import {
  BroadcastCopyRef,
  ChatMessagePayload,
  MessageSentAckPayload,
  NewConversationPayload,
} from "@/types/socket.types";

// ============================================================================
// Broadcast lists (WhatsApp-style) — see BROADCAST_LISTS.md for the contract.
//
// A list IS a chat (chats.type = 'broadcast', owner_id = creater_id = sender)
// whose ONLY chat_members row is the owner (role admin). Recipients live in
// broadcast_recipients, so nothing chat-scoped can ever reach them. A message
// sent into the list chat is stored there as the sender's copy and copied
// into the sender's 1:1 DM with every recipient — recipients only ever see an
// ordinary DM message from the sender.
// ============================================================================

type BroadcastRecipientDTO = {
  id: string;
  name: string;
  phone: string | null;
  profile_pic: string | null;
};

type BroadcastListDTO = {
  id: string;
  title: string | null;
  created_at: string;
  recipient_count: number;
  recipients: BroadcastRecipientDTO[];
};

type BroadcastCopyDTO = {
  broadcast_msg_id: string;
  recipient_id: string;
  conv_id: string;
  msg_id: string;
  delivered_at: string | null;
  read_at: string | null;
};

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const not_found = (): ResultType<never> => ({
  success: false,
  code: 404,
  message: "Broadcast list not found",
});

const bad_request = (message: string): ResultType<never> => ({
  success: false,
  code: 400,
  message,
});

// ─── list CRUD ──────────────────────────────────────────────────────────────

// The caller's live list, or null. Not-yours, deleted and not-a-broadcast all
// collapse into null → 404, so the endpoint never confirms another user's list
// exists.
const load_owned_list = async (owner_id: string, list_id: string) => {
  if (!is_uuid(list_id)) return null;
  const [row] = await db
    .select({
      id: chat_model.id,
      title: chat_model.title,
      created_at: chat_model.created_at,
    })
    .from(chat_model)
    .where(
      and(
        eq(chat_model.id, list_id),
        eq(chat_model.type, "broadcast"),
        eq(chat_model.owner_id, owner_id),
        isNull(chat_model.deleted_at),
      ),
    )
    .limit(1);
  return row ?? null;
};

const build_list_dto = async (list: {
  id: string;
  title: string | null;
  created_at: Date;
}): Promise<BroadcastListDTO> => {
  const recipients = await db
    .select({
      id: user_model.id,
      name: user_model.name,
      phone: user_model.phone,
      profile_pic: user_model.profile_pic,
    })
    .from(broadcast_recipient_model)
    .innerJoin(user_model, eq(user_model.id, broadcast_recipient_model.user_id))
    .where(eq(broadcast_recipient_model.list_id, list.id))
    .orderBy(asc(broadcast_recipient_model.added_at), asc(user_model.name));

  return {
    id: list.id,
    title: list.title ?? null,
    created_at: new Date(list.created_at).toISOString(),
    recipient_count: recipients.length,
    recipients,
  };
};

// Keep only ids that are real users, preserving the caller's order. Unknown ids
// (e.g. an account deleted after the picker loaded) are dropped rather than
// failing the whole request — the returned DTO shows what was actually saved.
const filter_existing_users = async (ids: string[]): Promise<string[]> => {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: user_model.id })
    .from(user_model)
    .where(inArray(user_model.id, ids));
  const found = new Set(rows.map((r) => r.id.toLowerCase()));
  return ids.filter((id) => found.has(id));
};

const create_broadcast_list = async (
  owner_id: string,
  raw_title: unknown,
  raw_recipient_ids: unknown,
): Promise<ResultType<BroadcastListDTO>> => {
  try {
    const title = normalize_broadcast_title(raw_title);
    if (!title.ok) return bad_request(title.message);

    const recipient_ids = await filter_existing_users(
      normalize_recipient_ids(raw_recipient_ids, owner_id),
    );
    if (recipient_ids.length === 0) {
      return bad_request("A broadcast list needs at least one recipient");
    }
    if (recipient_ids.length > BROADCAST_MAX_RECIPIENTS) {
      return bad_request(`A broadcast list can have at most ${BROADCAST_MAX_RECIPIENTS} recipients`);
    }

    const list = await db.transaction(async (tx) => {
      const [chat] = await tx
        .insert(chat_model)
        .values({
          type: "broadcast",
          creater_id: owner_id,
          owner_id,
          title: title.value,
        })
        .returning({
          id: chat_model.id,
          title: chat_model.title,
          created_at: chat_model.created_at,
        });
      // The owner is the ONLY member — recipients are never chat members.
      await tx.insert(chat_member_model).values({
        chat_id: chat.id,
        user_id: owner_id,
        role: "admin",
        status: "active",
      });
      await tx
        .insert(broadcast_recipient_model)
        .values(recipient_ids.map((user_id) => ({ list_id: chat.id, user_id })));
      return chat;
    });

    // Warm both caches the send path reads first: the membership gate
    // (is_member) and the chat-type branch.
    prime_chat_type(list.id, "broadcast");
    await add_members([owner_id], list.id);

    return {
      success: true,
      code: 200,
      message: "Broadcast list created",
      data: await build_list_dto(list),
    };
  } catch (error) {
    console.error("create_broadcast_list error:", error);
    return { success: false, code: 500, message: "ERROR : create_broadcast_list" };
  }
};

const get_broadcast_list = async (
  owner_id: string,
  list_id: string,
): Promise<ResultType<BroadcastListDTO>> => {
  try {
    const list = await load_owned_list(owner_id, list_id);
    if (!list) return not_found();
    return { success: true, code: 200, message: "Broadcast list", data: await build_list_dto(list) };
  } catch (error) {
    console.error("get_broadcast_list error:", error);
    return { success: false, code: 500, message: "ERROR : get_broadcast_list" };
  }
};

/**
 * Rename and/or add/remove recipients. Applied as (current ∪ add) \ remove, so
 * an id in both lists ends up removed. The result may be EMPTY (the app blocks
 * sending to a 0-recipient list) but never above BROADCAST_MAX_RECIPIENTS.
 * `title` absent = unchanged, null / "" = cleared.
 */
const update_broadcast_list = async (
  owner_id: string,
  list_id: string,
  patch: { title?: unknown; add_ids?: unknown; remove_ids?: unknown },
): Promise<ResultType<BroadcastListDTO>> => {
  try {
    if (!is_uuid(list_id)) return not_found();

    let title: string | null | undefined = undefined;
    if (patch.title !== undefined) {
      const t = normalize_broadcast_title(patch.title);
      if (!t.ok) return bad_request(t.message);
      title = t.value;
    }
    const add_ids = await filter_existing_users(normalize_recipient_ids(patch.add_ids, owner_id));
    const remove_ids = normalize_recipient_ids(patch.remove_ids, owner_id);

    const outcome = await db.transaction(async (tx) => {
      // Row lock on the list: two concurrent PATCHes each passing the cap
      // check against the same snapshot could otherwise push it past 250.
      const [list] = await tx
        .select({ id: chat_model.id })
        .from(chat_model)
        .where(
          and(
            eq(chat_model.id, list_id),
            eq(chat_model.type, "broadcast"),
            eq(chat_model.owner_id, owner_id),
            isNull(chat_model.deleted_at),
          ),
        )
        .limit(1)
        .for("update");
      if (!list) return "not_found" as const;

      const current = await tx
        .select({ user_id: broadcast_recipient_model.user_id })
        .from(broadcast_recipient_model)
        .where(eq(broadcast_recipient_model.list_id, list_id));
      const final = new Set(current.map((r) => r.user_id.toLowerCase()));
      for (const id of add_ids) final.add(id);
      for (const id of remove_ids) final.delete(id);
      if (final.size > BROADCAST_MAX_RECIPIENTS) return "too_many" as const;

      const remove_set = new Set(remove_ids);
      const to_add = add_ids.filter((id) => !remove_set.has(id));
      if (to_add.length > 0) {
        await tx
          .insert(broadcast_recipient_model)
          .values(to_add.map((user_id) => ({ list_id, user_id })))
          .onConflictDoNothing();
      }
      if (remove_ids.length > 0) {
        await tx
          .delete(broadcast_recipient_model)
          .where(
            and(
              eq(broadcast_recipient_model.list_id, list_id),
              inArray(broadcast_recipient_model.user_id, remove_ids),
            ),
          );
      }
      if (title !== undefined) {
        await tx.update(chat_model).set({ title }).where(eq(chat_model.id, list_id));
      }
      return "ok" as const;
    });

    if (outcome === "not_found") return not_found();
    if (outcome === "too_many") {
      return bad_request(`A broadcast list can have at most ${BROADCAST_MAX_RECIPIENTS} recipients`);
    }

    const list = await load_owned_list(owner_id, list_id);
    if (!list) return not_found();
    return { success: true, code: 200, message: "Broadcast list updated", data: await build_list_dto(list) };
  } catch (error) {
    console.error("update_broadcast_list error:", error);
    return { success: false, code: 500, message: "ERROR : update_broadcast_list" };
  }
};

/**
 * Soft-delete (chats.deleted_at = now()). The chat-list query already hides
 * deleted chats, so the app's reconcile drops it; the send path refuses a
 * deleted list with a 403 ack. Copies already delivered stay in the DMs —
 * they are ordinary messages there.
 */
const delete_broadcast_list = async (
  owner_id: string,
  list_id: string,
): Promise<ResultType<{ id: string }>> => {
  try {
    if (!is_uuid(list_id)) return not_found();
    const [row] = await db
      .update(chat_model)
      .set({ deleted_at: new Date() })
      .where(
        and(
          eq(chat_model.id, list_id),
          eq(chat_model.type, "broadcast"),
          eq(chat_model.owner_id, owner_id),
          isNull(chat_model.deleted_at),
        ),
      )
      .returning({ id: chat_model.id });
    if (!row) return not_found();
    return { success: true, code: 200, message: "Broadcast list deleted", data: { id: row.id } };
  } catch (error) {
    console.error("delete_broadcast_list error:", error);
    return { success: false, code: 500, message: "ERROR : delete_broadcast_list" };
  }
};

/**
 * Per-recipient copies of the caller's broadcast messages, with
 * server-authoritative delivery/read state: message_info merged with the
 * unflushed Redis msg_status:* hashes, exactly the way get_message_statuses
 * merges them (a persisted value wins; Redis fills what hasn't been flushed).
 * Only messages in lists the caller OWNS are returned — anything else simply
 * yields no rows.
 */
const get_broadcast_copies = async (
  owner_id: string,
  raw_ids: unknown,
): Promise<ResultType<BroadcastCopyDTO[]>> => {
  try {
    const ids = Array.from(
      new Set((Array.isArray(raw_ids) ? raw_ids : []).filter(is_uuid).map((id) => id.toLowerCase())),
    );
    if (ids.length > BROADCAST_COPIES_MAX_IDS) {
      return bad_request(`At most ${BROADCAST_COPIES_MAX_IDS} broadcast message ids per request`);
    }
    if (ids.length === 0) return { success: true, code: 200, message: "No copies", data: [] };

    const bmc = broadcast_message_copy_model;
    const rows = await db
      .select({
        broadcast_msg_id: bmc.broadcast_msg_id,
        recipient_id: bmc.recipient_id,
        conv_id: bmc.chat_id,
        msg_id: bmc.message_id,
        delivered_at: message_info_model.delivered_at,
        read_at: message_info_model.read_at,
      })
      .from(bmc)
      .innerJoin(message_model, eq(message_model.id, bmc.broadcast_msg_id))
      .innerJoin(
        chat_model,
        and(
          eq(chat_model.id, message_model.chat_id),
          eq(chat_model.type, "broadcast"),
          eq(chat_model.owner_id, owner_id),
        ),
      )
      .leftJoin(
        message_info_model,
        and(
          eq(message_info_model.message_id, bmc.message_id),
          eq(message_info_model.user_id, bmc.recipient_id),
        ),
      )
      .where(inArray(bmc.broadcast_msg_id, ids));

    const redis_statuses = await get_message_statuses_bulk(
      Array.from(new Set(rows.map((r) => r.msg_id))),
    );
    const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

    const data: BroadcastCopyDTO[] = rows.map((r) => {
      const cached = redis_statuses.get(r.msg_id)?.get(r.recipient_id);
      return {
        broadcast_msg_id: r.broadcast_msg_id,
        recipient_id: r.recipient_id,
        conv_id: r.conv_id,
        msg_id: r.msg_id,
        delivered_at: iso(r.delivered_at) ?? cached?.delivered_at ?? null,
        read_at: iso(r.read_at) ?? cached?.read_at ?? null,
      };
    });

    return { success: true, code: 200, message: "Broadcast copies", data };
  } catch (error) {
    console.error("get_broadcast_copies error:", error);
    return { success: false, code: 500, message: "ERROR : get_broadcast_copies" };
  }
};

// ─── send path ──────────────────────────────────────────────────────────────

// Advisory-lock namespaces + the DM-pair key/lock builders live in
// broadcast.utils: create_dm takes the SAME pair lock, so both paths must
// share one derivation.

type ResolvedDm = {
  dm_id: string;
  disappearing_after_sec: number | null;
  // Some membership row of this DM has removed_at set (either side "deleted
  // it for me") and must be revived before the copy lands.
  needs_revive: boolean;
};

type CopyDelivery = {
  recipient_id: string;
  dm_id: string;
  copy_id: string;
  expires_at: Date | null;
  // Recipient's client has no local row for this DM (brand new, or they had
  // hidden it) → conversation:new must reach them BEFORE the message:new.
  announce_conversation: boolean;
  // DM membership changed in this send (created or revived) → the Redis
  // member sets must be (re)hydrated so later normal DM sends fan out.
  membership_changed: boolean;
};

type BroadcastTxResult =
  | { kind: "duplicate"; sent_at: Date | null; copies: BroadcastCopyRef[] }
  | { kind: "foreign_duplicate" }
  | { kind: "no_recipients" }
  | { kind: "stored"; sender_copy: DBMessageType; deliveries: CopyDelivery[] };

// When a recipient has several live DMs with the sender (legacy duplicates),
// copy into the one both clients are actually using: most recent activity
// first, oldest creation as the tie-break.
const pick_dm = <T extends { last_msg_at: Date | null; created_at: Date }>(a: T, b: T): T => {
  const at = a.last_msg_at ? new Date(a.last_msg_at).getTime() : -Infinity;
  const bt = b.last_msg_at ? new Date(b.last_msg_at).getTime() : -Infinity;
  if (at !== bt) return at > bt ? a : b;
  return new Date(a.created_at).getTime() <= new Date(b.created_at).getTime() ? a : b;
};

/**
 * Existing DMs between `sender_id` and each of `recipient_ids`, in at most two
 * queries:
 *   1. live DMs (both membership rows have removed_at IS NULL). This is the
 *      steady state for any list that has been sent to before, and it rides
 *      the partial (user_id, chat_id) / (chat_id, user_id) indexes.
 *   2. only for recipients still unresolved: DMs where either side hid the
 *      chat. create_dm's rule — a hidden DM is revived, never duplicated,
 *      or the shared history would be orphaned. This lookup can't use the
 *      partial indexes, which is why it only runs for the leftovers.
 */
const find_existing_dms = async (
  tx: Tx,
  sender_id: string,
  recipient_ids: string[],
): Promise<Map<string, ResolvedDm>> => {
  const out = new Map<string, ResolvedDm>();
  if (recipient_ids.length === 0) return out;

  const me = alias(chat_member_model, "me");
  const them = alias(chat_member_model, "them");
  const columns = {
    dm_id: chat_model.id,
    recipient_id: them.user_id,
    disappearing_after_sec: chat_model.disappearing_after_sec,
    last_msg_at: chat_model.last_msg_at,
    created_at: chat_model.created_at,
  };
  type Row = {
    dm_id: string;
    recipient_id: string | null;
    disappearing_after_sec: number | null;
    last_msg_at: Date | null;
    created_at: Date;
  };
  const collect = (rows: Row[], needs_revive: boolean) => {
    const best = new Map<string, Row>();
    for (const r of rows) {
      if (!r.recipient_id) continue;
      const rid = r.recipient_id.toLowerCase();
      const prev = best.get(rid);
      best.set(rid, prev ? pick_dm(prev, r) : r);
    }
    for (const [rid, r] of best) {
      if (out.has(rid)) continue;
      out.set(rid, {
        dm_id: r.dm_id,
        disappearing_after_sec: r.disappearing_after_sec,
        needs_revive,
      });
    }
  };

  const live = await tx
    .select(columns)
    .from(me)
    .innerJoin(
      chat_model,
      and(eq(chat_model.id, me.chat_id), eq(chat_model.type, "dm"), isNull(chat_model.deleted_at)),
    )
    .innerJoin(
      them,
      and(eq(them.chat_id, me.chat_id), inArray(them.user_id, recipient_ids), isNull(them.removed_at)),
    )
    .where(and(eq(me.user_id, sender_id), isNull(me.removed_at)));
  collect(live, false);

  const leftover = recipient_ids.filter((id) => !out.has(id));
  if (leftover.length === 0) return out;

  const hidden = await tx
    .select(columns)
    .from(me)
    .innerJoin(
      chat_model,
      and(eq(chat_model.id, me.chat_id), eq(chat_model.type, "dm"), isNull(chat_model.deleted_at)),
    )
    .innerJoin(them, and(eq(them.chat_id, me.chat_id), inArray(them.user_id, leftover)))
    .where(eq(me.user_id, sender_id));
  collect(hidden, true);

  return out;
};

const rows_of = <T>(result: unknown): T[] => {
  // postgres-js returns the row array itself; node-postgres wraps it in
  // { rows } — same defensive read the disappearing sweeper uses.
  const rows = (result as any)?.rows ?? result ?? [];
  return Array.isArray(rows) ? (rows as T[]) : [];
};

const uuid_list = (ids: string[]) => sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);

/**
 * What a duplicate send is re-acked with: the stored sent_at + the copy ledger.
 * Null unless `msg_id` is THIS sender's message in THIS list — a crafted frame
 * reusing someone else's message id must not read back that broadcast's
 * recipients. Runs inside the send transaction (the normal duplicate check)
 * and on plain `db` (the deleted-list resend check), hence the narrow param.
 */
const read_stored_broadcast = async (
  exec: Pick<Tx, "select">,
  msg_id: string,
  list_id: string,
  sender_id: string,
): Promise<{ sent_at: Date | null; copies: BroadcastCopyRef[] } | null> => {
  const [existing] = await exec
    .select({ sent_at: message_model.sent_at })
    .from(message_model)
    .where(
      and(
        eq(message_model.id, msg_id),
        eq(message_model.chat_id, list_id),
        eq(message_model.sender_id, sender_id),
      ),
    )
    .limit(1);
  if (!existing) return null;
  const copies = await exec
    .select({
      recipient_id: broadcast_message_copy_model.recipient_id,
      conv_id: broadcast_message_copy_model.chat_id,
      msg_id: broadcast_message_copy_model.message_id,
    })
    .from(broadcast_message_copy_model)
    .where(eq(broadcast_message_copy_model.broadcast_msg_id, msg_id));
  return { sent_at: existing.sent_at, copies };
};

/**
 * The whole durable part of a broadcast send, in ONE transaction:
 *   lock(sender) → sender copy (idempotency gate) → recipients → resolve DMs
 *   → revive hidden memberships → create missing DMs → copies → copy index.
 *
 * Deviation from the contract's listed order (documented): the sender copy is
 * inserted FIRST, not last — broadcast_message_copies.broadcast_msg_id is a
 * foreign key to it, and its onConflictDoNothing doubles as the duplicate
 * check under the lock. Same transaction, so the committed result is identical.
 */
const run_broadcast_transaction = async (args: {
  payload: ChatMessagePayload;
  sender_id: string;
  list_id: string;
  sent_at: Date;
  list_disappearing_after_sec: number | null;
}): Promise<BroadcastTxResult> =>
  db.transaction(async (tx) => {
    const { payload, sender_id, list_id, sent_at } = args;

    // Bounded waits (see tx_timeouts_sql): a stalled lock holder turns into a
    // retryable 500 ack instead of piling pooled connections up behind it.
    await tx.execute(tx_timeouts_sql());

    // Serialize this sender's broadcast sends. A media group or a split long
    // text arrives as several concurrent message:new frames; without this two
    // of them would both see "no DM with X yet" and create two DMs.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${LOCK_NS_BROADCAST_SENDER}::int, hashtext(${sender_id}::text))`,
    );

    const recipient_rows = await tx
      .select({ user_id: broadcast_recipient_model.user_id })
      .from(broadcast_recipient_model)
      .where(eq(broadcast_recipient_model.list_id, list_id));
    // Every id compared in JS is lowercased (Postgres returns uuids that way;
    // the JWT id is normalised too) so set/map lookups can't miss on case.
    const sender_lc = sender_id.toLowerCase();
    const recipient_ids = Array.from(
      new Set(recipient_rows.map((r) => r.user_id.toLowerCase())),
    ).filter((id) => id !== sender_lc);

    // An empty list is refused instead of stored: acking it would give the
    // sender a "sent" tick for a message nobody received. The app hides the
    // composer at 0 recipients, but a retry of an older failed/pending
    // message (resend, GC, media upload retry) still lands here. A message
    // that WAS stored while the list still had recipients stays an
    // idempotent re-ack.
    if (recipient_ids.length === 0) {
      const stored = await read_stored_broadcast(tx, payload.id, list_id, sender_id);
      if (stored) {
        return { kind: "duplicate" as const, sent_at: stored.sent_at, copies: stored.copies };
      }
      return { kind: "no_recipients" as const };
    }

    // Sender copy — idempotent on the client id, exactly like store_message.
    // replied_to is kept here (the sender's own view; same as store_message)
    // but never propagated to the copies.
    const [sender_copy] = await tx
      .insert(message_model)
      .values({
        id: payload.id,
        chat_id: list_id,
        replied_to: payload.replied_to || null,
        sender_id,
        type: payload.msg_type,
        body: payload.body,
        attachments: payload.attachments,
        sent_at,
        expires_at:
          args.list_disappearing_after_sec != null
            ? new Date(sent_at.getTime() + args.list_disappearing_after_sec * 1000)
            : null,
      })
      .onConflictDoNothing({ target: message_model.id })
      .returning();

    if (!sender_copy) {
      // Already stored → a benign resend. Re-ack from what is persisted; no
      // fan-out. The existing row must be THIS sender's message in THIS list
      // (read_stored_broadcast enforces it).
      const stored = await read_stored_broadcast(tx, payload.id, list_id, sender_id);
      if (!stored) return { kind: "foreign_duplicate" as const };
      return { kind: "duplicate" as const, sent_at: stored.sent_at, copies: stored.copies };
    }

    const resolved = await find_existing_dms(tx, sender_id, recipient_ids);

    // The sender lock only serializes THIS sender. A and B broadcasting to
    // each other at the same moment would each still see "no DM" and create
    // one — and so would a create_dm racing this send. So before creating,
    // take the per-PAIR lock (the same one create_dm takes) for every pair
    // that needs a DM and look again. dm_pair_locks_sql acquires them in one
    // sorted statement, so overlapping transactions can't deadlock.
    let missing = recipient_ids.filter((id) => !resolved.has(id));
    if (missing.length > 0) {
      await tx.execute(dm_pair_locks_sql(missing.map((rid) => dm_pair_lock_key(sender_lc, rid))));
      const late = await find_existing_dms(tx, sender_id, missing);
      for (const [rid, dm] of late) resolved.set(rid, dm);
      missing = recipient_ids.filter((id) => !resolved.has(id));
    }

    // Revive hidden memberships (both sides — the sender may have hidden the
    // DM too, and the copy must reappear in their list). One row per
    // (chat, user), and never alongside an already-live row: the partial
    // unique index on live rows would otherwise abort the WHOLE broadcast for
    // one malformed legacy DM.
    const revive_dm_ids = Array.from(
      new Set(Array.from(resolved.values()).filter((d) => d.needs_revive).map((d) => d.dm_id)),
    );
    const revived_pairs = new Set<string>(); // `${chat_id}:${user_id}`
    const revived_chats = new Set<string>();
    if (revive_dm_ids.length > 0) {
      const revived = rows_of<{ chat_id: string; user_id: string }>(
        await tx.execute(sql`
          UPDATE ${chat_member_model} AS cm
          SET removed_at = NULL
          WHERE cm.id IN (
            SELECT DISTINCT ON (r.chat_id, r.user_id) r.id
            FROM ${chat_member_model} AS r
            WHERE r.chat_id IN (${uuid_list(revive_dm_ids)})
              AND r.removed_at IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM ${chat_member_model} AS a
                WHERE a.chat_id = r.chat_id
                  AND a.user_id = r.user_id
                  AND a.removed_at IS NULL
              )
            ORDER BY r.chat_id, r.user_id, r.joined_at DESC NULLS LAST
          )
          RETURNING cm.chat_id::text AS chat_id, cm.user_id::text AS user_id
        `),
      );
      for (const r of revived) {
        if (!r.chat_id || !r.user_id) continue;
        revived_pairs.add(`${r.chat_id.toLowerCase()}:${r.user_id.toLowerCase()}`);
        revived_chats.add(r.chat_id.toLowerCase());
      }
    }

    // Brand-new DMs for everyone left: same rows create_dm writes (chat type
    // dm, creater = sender, two plain member rows). Bulk, ids minted here so
    // each recipient maps to its chat without a RETURNING round-trip.
    const created = new Set<string>();
    if (missing.length > 0) {
      const new_dms = missing.map((rid) => ({ recipient_id: rid, dm_id: crypto.randomUUID() }));
      await tx.insert(chat_model).values(
        new_dms.map((d) => ({ id: d.dm_id, creater_id: sender_id, type: "dm" as const })),
      );
      // joined_at defaults to now() — the TRANSACTION start time. The copies
      // below take created_at = clock_timestamp() (strictly later), otherwise
      // get_conversation_history's `created_at > joined_at` floor would hide
      // the very first message of the new DM from both sides.
      await tx.insert(chat_member_model).values(
        new_dms.flatMap((d) => [
          { chat_id: d.dm_id, user_id: sender_id },
          { chat_id: d.dm_id, user_id: d.recipient_id },
        ]),
      );
      for (const d of new_dms) {
        resolved.set(d.recipient_id, { dm_id: d.dm_id, disappearing_after_sec: null, needs_revive: false });
        created.add(d.recipient_id);
      }
    }

    const sent_ms = sent_at.getTime();
    const deliveries: CopyDelivery[] = recipient_ids.map((rid) => {
      const dm = resolved.get(rid)!;
      const dm_key = dm.dm_id.toLowerCase();
      const is_new = created.has(rid);
      return {
        recipient_id: rid,
        dm_id: dm.dm_id,
        copy_id: derive_broadcast_copy_id(payload.id, rid, sent_ms),
        // Each copy follows ITS DM's disappearing setting, not the list's.
        expires_at:
          dm.disappearing_after_sec != null
            ? new Date(sent_ms + dm.disappearing_after_sec * 1000)
            : null,
        announce_conversation: is_new || revived_pairs.has(`${dm_key}:${rid}`),
        membership_changed: is_new || revived_chats.has(dm_key),
      };
    });

    // The copies: ordinary DM messages from the sender. No replied_to — the
    // replied-to message lives in the broadcast chat, which recipients can't see.
    await tx
      .insert(message_model)
      .values(
        deliveries.map((d) => ({
          id: d.copy_id,
          chat_id: d.dm_id,
          sender_id,
          type: payload.msg_type,
          body: payload.body,
          attachments: payload.attachments,
          replied_to: null,
          sent_at,
          expires_at: d.expires_at,
          created_at: sql`clock_timestamp()`,
        })),
      )
      .onConflictDoNothing({ target: message_model.id });

    await tx
      .insert(broadcast_message_copy_model)
      .values(
        deliveries.map((d) => ({
          broadcast_msg_id: payload.id,
          recipient_id: d.recipient_id,
          chat_id: d.dm_id,
          message_id: d.copy_id,
        })),
      )
      .onConflictDoNothing();

    return { kind: "stored" as const, sender_copy, deliveries };
  });

// Per-sender fan-out ordering (process-local, best effort). The advisory lock
// orders COMMITS, but fan-outs run after commit and could interleave: message
// 2's message:new could reach a recipient before message 1's conversation:new
// created their DM locally. Each sender's fan-outs are therefore chained in
// commit order. A sender's frames all arrive on their one socket → one PM2
// worker, so a local chain covers it; only a simultaneous WS + HTTP-poll send
// split across workers escapes it. No shared state: losing this map loses
// ordering only, never data.
const sender_fanout_tail = new Map<string, Promise<void>>();
// Upper bound on how long a reserved fan-out waits for its sender ack to go out.
const ACK_GATE_MAX_WAIT_MS = 10_000;

// Per-sender transaction mutex (process-local). The advisory lock alone would
// be correct, but every waiter holds a pooled DB connection WHILE it waits: a
// 10-item media group to a list would park 10 transactions on one lock and
// can drain the whole pool (postgres-js default max = 10), stalling every
// other request on this worker. Queuing same-sender sends here first means
// one connection per sender at a time; the advisory lock remains the
// cross-worker guarantee.
const sender_tx_tail = new Map<string, Promise<void>>();

const run_exclusive_for_sender = async <T>(sender_id: string, fn: () => Promise<T>): Promise<T> => {
  const prev = sender_tx_tail.get(sender_id) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prev.then(() => gate); // never rejects: gates only resolve
  sender_tx_tail.set(sender_id, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (sender_tx_tail.get(sender_id) === tail) sender_tx_tail.delete(sender_id);
  }
};

const enqueue_sender_fanout = (sender_id: string, job: () => Promise<void>): Promise<void> => {
  const prev = sender_fanout_tail.get(sender_id) ?? Promise.resolve();
  const next = prev
    .then(job)
    .catch((err) => console.error(`[BROADCAST] fan-out failed (sender ${sender_id}):`, err));
  sender_fanout_tail.set(sender_id, next);
  void next.then(() => {
    if (sender_fanout_tail.get(sender_id) === next) sender_fanout_tail.delete(sender_id);
  });
  return next;
};

type Presence = Awaited<ReturnType<typeof broadcast_message>>;

const fan_out_broadcast = async (ctx: {
  payload: ChatMessagePayload;
  sender_id: string;
  list_id: string;
  sent_at: Date;
  sender_copy: DBMessageType;
  deliveries: CopyDelivery[];
}): Promise<void> => {
  const { payload, sender_id, list_id, sent_at, deliveries } = ctx;
  const sent_at_iso = sent_at.toISOString();

  // 1. Membership caches for DMs created/revived in this send — BEFORE the
  //    message lands, so a reply in the DM fans out to both parties.
  const changed = deliveries.filter((d) => d.membership_changed);
  if (changed.length > 0) {
    await add_members_bulk(
      changed.map((d) => ({ chat_id: d.dm_id, user_ids: [sender_id, d.recipient_id] })),
    );
  }

  // 2. Sender profile drives conversation:new (the peer, from the recipient's POV).
  //    A failed lookup must not cost every recipient their message: it only
  //    skips conversation:new (same outcome as revive_hidden_dm_members when
  //    the sender row is missing).
  let sender_profile: { id: string; name: string; phone: string | null; profile_pic: string | null } | undefined;
  if (deliveries.some((d) => d.announce_conversation)) {
    try {
      [sender_profile] = await db
        .select({
          id: user_model.id,
          name: user_model.name,
          phone: user_model.phone,
          profile_pic: user_model.profile_pic,
        })
        .from(user_model)
        .where(eq(user_model.id, sender_id))
        .limit(1);
    } catch (err) {
      console.error("[BROADCAST] sender profile lookup failed:", err);
    }
  }

  // The copy payload is built from an explicit whitelist rather than by
  // spreading the client's frame (as the normal path does): whatever else the
  // broadcast frame carried — the list id, a reply target — must never reach
  // a recipient. Re-homed into each DM with the copy id and the stored
  // sent_at / expires_at.
  const copy_payload = (d: CopyDelivery): ChatMessagePayload => ({
    id: d.copy_id,
    conv_id: d.dm_id,
    sender_id,
    msg_type: payload.msg_type,
    body: payload.body,
    attachments: payload.attachments,
    replied_to_message: null,
    sent_at,
    expires_at: d.expires_at,
  });

  // 3. Last-message pointers: every DM + the list itself, one Redis pipeline
  //    + one Postgres UPDATE (monotonic per row, like set_last_message).
  //    Written BEFORE any recipient can see the copy: they don't depend on
  //    presence, and the Redis half is last-writer-wins — written after the
  //    delivery loop, a recipient who got the copy early and replied within
  //    the (up to ~10-wave) fan-out had their newer reply's preview
  //    overwritten by this older message.
  const base_meta = {
    body: payload.body ?? "",
    type: payload.msg_type,
    sender_id,
    sent_at: sent_at_iso,
    attachments: payload.attachments ?? null,
  };
  await batch_set_last_message([
    { chat_id: list_id, msg: { id: ctx.sender_copy.id, ...base_meta } },
    ...deliveries.map((d) => ({ chat_id: d.dm_id, msg: { id: d.copy_id, ...base_meta } })),
  ]);

  const in_bucket = (p: Presence | undefined, rid: string) => ({
    offline: !!p?.offline.includes(rid),
    online: !!p?.online.includes(rid),
    polling: !!p?.polling.includes(rid),
    background: !!p?.background.includes(rid),
  });

  // 4. Per-recipient delivery, bounded concurrency. conversation:new strictly
  //    before message:new for the same recipient (FIFO on their socket and in
  //    the pending queue). One broadcast_message call per recipient per event:
  //    it is the per-user primitive, and its FIRST call is the only one that
  //    buckets a polling user correctly (it evicts the poll connection as a
  //    side effect), so the presence of the first call is what we keep.
  //
  //    Unread +1 lands right after THIS recipient's message:new (same bucket
  //    rule as handle_message_new: offline ∪ online ∪ polling), not in one
  //    batch after the whole loop: a recipient who opened the DM and read-acked
  //    mid-fan-out got reset_unread → 0 and THEN the late batch +1, a phantom
  //    unread badge. Exactly once per copy: each delivery is visited once, and
  //    a failed delivery (no presence recorded) increments nothing.
  const presence = new Map<string, Presence>();
  await for_each_with_concurrency(deliveries, BROADCAST_FANOUT_CONCURRENCY, async (d) => {
    let first: Presence | null = null;
    if (d.announce_conversation && sender_profile) {
      const conv_payload: NewConversationPayload = {
        conv_id: d.dm_id,
        conv_type: "dm",
        creater_id: sender_profile.id,
        creater_name: sender_profile.name,
        creater_phone: sender_profile.phone || "",
        creater_pfp: sender_profile.profile_pic || undefined,
        joined_at: new Date(),
      };
      first = await broadcast_message({
        to: "users",
        user_ids: [d.recipient_id],
        message: { type: "conversation:new", payload: conv_payload, ws_timestamp: new Date() },
      });
    }
    const delivered = await broadcast_message({
      to: "users",
      user_ids: [d.recipient_id],
      message: { type: "message:new", payload: copy_payload(d), ws_timestamp: new Date() },
    });
    const p = first ?? delivered;
    presence.set(d.recipient_id, p);
    const b = in_bucket(p, d.recipient_id);
    if (b.offline || b.online || b.polling) {
      await increment_unread(d.recipient_id, d.dm_id); // never rejects
    }
  });

  // 5. FCM for offline + backgrounded recipients (background ⊂ online, and
  //    disjoint from offline, so nobody is queued twice). Muted → silent. Mutes
  //    come from ONE chat_members query over all the DMs instead of a per-chat
  //    get_muted_user_ids round-trip each.
  const fcm_targets = deliveries.filter((d) => {
    const b = in_bucket(presence.get(d.recipient_id), d.recipient_id);
    return b.offline || b.background;
  });
  if (fcm_targets.length > 0) {
    const muted = new Set<string>();
    try {
      const rows = await db
        .select({ chat_id: chat_member_model.chat_id, user_id: chat_member_model.user_id })
        .from(chat_member_model)
        .where(
          and(
            inArray(chat_member_model.chat_id, fcm_targets.map((d) => d.dm_id)),
            inArray(chat_member_model.user_id, fcm_targets.map((d) => d.recipient_id)),
            gt(chat_member_model.muted_until, new Date()),
            isNull(chat_member_model.removed_at),
          ),
        );
      for (const r of rows) {
        if (r.user_id) muted.add(`${r.chat_id.toLowerCase()}:${r.user_id.toLowerCase()}`);
      }
    } catch (err) {
      // Unknown mute state degrades to an audible push, never a lost one.
      console.error("[BROADCAST] mute lookup failed:", err);
    }
    for (const d of fcm_targets) {
      queue_message_fcm(
        d.recipient_id,
        { type: "message:new", payload: copy_payload(d), ws_timestamp: new Date() },
        { silent: muted.has(`${d.dm_id.toLowerCase()}:${d.recipient_id}`) },
      ).catch((err) => console.error("[BROADCAST] FCM queue failed:", err));
    }
  }
};

const send_sent_ack = async (user_id: string, ack: MessageSentAckPayload): Promise<void> => {
  await broadcast_message({
    to: "users",
    user_ids: [user_id],
    message: { type: "message:sent:ack", payload: ack, ws_timestamp: new Date() },
  });
};

/**
 * message:new into a broadcast-list chat. Called by handle_message_new AFTER
 * its membership gate, once the chat type is known to be 'broadcast'. Never
 * throws; every exit acks the sender.
 */
const handle_broadcast_message_new = async (
  payload: ChatMessagePayload,
  auth_user_id: string | undefined,
): Promise<ResultType> => {
  const reject = async (code: number, message: string): Promise<ResultType> => {
    await send_sent_ack(auth_user_id || payload.sender_id, {
      msg_id: payload.id,
      conv_id: payload.conv_id,
      is_sent: false,
      error_code: code,
    });
    return { success: false, code, message };
  };

  // Idempotent re-ack of an already-stored broadcast message, from the
  // persisted sent_at + copy ledger. No fan-out: the first arrival did it.
  const ack_duplicate = async (
    sender_id: string,
    stored: { sent_at: Date | null; copies: BroadcastCopyRef[] },
  ): Promise<ResultType> => {
    console.warn(
      `[BROADCAST] idempotent duplicate ignored: msg_id=${payload.id} list=${payload.conv_id} sender=${sender_id}`,
    );
    await send_sent_ack(sender_id, {
      msg_id: payload.id,
      conv_id: payload.conv_id,
      is_sent: true,
      sent_at: stored.sent_at ?? undefined,
      broadcast_copies: stored.copies,
    });
    return { success: true, code: 200, message: "Duplicate broadcast message ignored (idempotent)" };
  };

  try {
    // Only the authenticated owner may post into their list. The normal path
    // trusts payload.sender_id; here a spoofed sender_id would make the server
    // write messages "from" the owner into hundreds of DMs, so it is checked.
    if (!auth_user_id || payload.sender_id !== auth_user_id) {
      return await reject(403, "sender_id does not match the authenticated user");
    }
    const sender_id = auth_user_id;

    const [list] = await db
      .select({
        owner_id: chat_model.owner_id,
        deleted_at: chat_model.deleted_at,
        disappearing_after_sec: chat_model.disappearing_after_sec,
      })
      .from(chat_model)
      .where(and(eq(chat_model.id, payload.conv_id), eq(chat_model.type, "broadcast")))
      .limit(1);
    if (!list || list.owner_id !== sender_id || list.deleted_at) {
      // A GC resend of a message that WAS stored before the list was deleted
      // (its ack got lost) must still get the idempotent re-ack — a 403 would
      // mark a delivered message failed on the sender's device. Only a
      // genuinely new message into an unusable list is refused. Off the hot
      // path: this lookup runs only when the list check already failed.
      let stored: Awaited<ReturnType<typeof read_stored_broadcast>>;
      try {
        stored = await read_stored_broadcast(db, payload.id, payload.conv_id, sender_id);
      } catch (err) {
        // Unknown ≠ refused: a transient 500 keeps it pending for the GC retry.
        console.error(`[BROADCAST] stored-message check failed msg=${payload.id} list=${payload.conv_id}:`, err);
        return await reject(500, "Failed to check broadcast message");
      }
      if (stored) return await ack_duplicate(sender_id, stored);
      return await reject(403, "Not your broadcast list (or it was deleted)");
    }

    // Same clamp / arrival-time rule as store_message (shared helper).
    const sent_at = resolve_stored_sent_at(payload.msg_type, payload.sent_at);

    // The ack gate: the fan-out job waits on it so the sender's ack always
    // goes out first, even though the job's slot is reserved before the ack.
    let open_ack_gate!: () => void;
    const ack_gate = new Promise<void>((resolve) => {
      open_ack_gate = resolve;
    });

    type Committed =
      | { stored: false; result: Exclude<BroadcastTxResult, { kind: "stored" }> }
      | {
        stored: true;
        result: Extract<BroadcastTxResult, { kind: "stored" }>;
        stored_sent_at: Date;
      };

    let committed: Committed;
    try {
      committed = await run_exclusive_for_sender(sender_id, async (): Promise<Committed> => {
        const result = await run_broadcast_transaction({
          payload,
          sender_id,
          list_id: payload.conv_id,
          sent_at,
          list_disappearing_after_sec: list.disappearing_after_sec,
        });
        if (result.kind !== "stored") return { stored: false, result };

        // Reserve this send's slot in the sender's fan-out chain while still
        // inside the exclusive section — synchronously after commit — so chain
        // order == commit order.
        const stored_sent_at = result.sender_copy.sent_at ?? sent_at;
        // Not awaited by this handler (see the end of it). The chain logs its
        // own failures and never rejects.
        void enqueue_sender_fanout(sender_id, async () => {
          // Bounded: every exit below opens the gate, but if a future change
          // ever missed one, the sender's whole fan-out chain must not wedge.
          await Promise.race([ack_gate, Bun.sleep(ACK_GATE_MAX_WAIT_MS)]);
          await fan_out_broadcast({
            payload,
            sender_id,
            list_id: payload.conv_id,
            sent_at: stored_sent_at,
            sender_copy: result.sender_copy,
            deliveries: result.deliveries,
          });
        });
        return { stored: true, result, stored_sent_at };
      });
    } catch (err) {
      open_ack_gate();
      // Nothing committed. A 500 ack keeps the message pending on the client
      // (transient), and the GC retry re-runs the whole idempotent transaction.
      console.error(`[BROADCAST] transaction failed msg=${payload.id} list=${payload.conv_id}:`, err);
      return await reject(500, "Failed to store broadcast message");
    }

    if (!committed.stored) {
      open_ack_gate(); // no fan-out was enqueued; nothing waits on it
      const { result } = committed;
      if (result.kind === "foreign_duplicate") {
        return await reject(409, "message id already exists");
      }
      if (result.kind === "no_recipients") {
        return await reject(422, "This broadcast list has no recipients");
      }
      return await ack_duplicate(sender_id, result);
    }

    const { deliveries } = committed.result;

    // Ack right after commit, BEFORE the fan-out (same reason as the normal
    // path: the single tick means "the server has it"), carrying every copy so
    // the app can mirror them into its local DMs.
    try {
      await send_sent_ack(sender_id, {
        msg_id: payload.id,
        conv_id: payload.conv_id,
        is_sent: true,
        sent_at: committed.stored_sent_at,
        broadcast_copies: deliveries.map((d) => ({
          recipient_id: d.recipient_id,
          conv_id: d.dm_id,
          msg_id: d.copy_id,
        })),
      });
    } finally {
      open_ack_gate();
    }

    // Return now — do NOT wait for the fan-out. For an HTTP-poll send this
    // handler's return is the HTTP response, and up to 250 recipients × a few
    // Redis round-trips, queued behind this sender's earlier fan-outs (a
    // media group), can approach the app's 25s request timeout → transport
    // demotion + a resend of a message that is already stored. The ack above
    // is the contract; ordering is unaffected because it comes from the
    // per-sender chain slot reserved inside the exclusive section, not from
    // this await.
    return {
      success: true,
      code: 200,
      message: `Broadcast message stored; fan-out to ${deliveries.length} recipient(s) queued`,
    };
  } catch (error) {
    console.error("[BROADCAST] handle_broadcast_message_new failed:", error);
    return { success: false, code: 500, message: "Failed to process broadcast message", error: error as any };
  }
};

// ─── delete-for-everyone cascade ────────────────────────────────────────────

// Broadcast ids per cascade UPDATE. Each id is one bind parameter; the copy
// ids themselves never become parameters (subquery below), so this only bounds
// a pathological client-supplied delete batch, far under the 65,535 limit.
const COPY_CASCADE_CHUNK = 1000;

/**
 * Soft-delete every still-live copy of the given (deleted) broadcast messages.
 * Returns the copies deleted BY THIS CALL so the caller can run the normal
 * per-DM deletion fan-out. Copies are the sender's own messages, so the same
 * ownership rule as the original delete applies (skipped only when elevated).
 *
 * Idempotent (`deleted_at IS NULL`): re-running it for a broadcast message
 * whose cascade already completed deletes and returns nothing, so the caller
 * may safely re-run it to heal a cascade that failed half-way.
 *
 * The copy ids are selected by a subquery on broadcast_message_copies rather
 * than read back and expanded into an IN-list: 250 copies per broadcast
 * message × a large delete batch would otherwise blow postgres' 65,535
 * bind-parameter limit.
 */
const soft_delete_broadcast_copies = async (
  broadcast_msg_ids: string[],
  user_id: string,
  is_admin_or_staff?: boolean,
): Promise<{ id: string; chat_id: string }[]> => {
  const out: { id: string; chat_id: string }[] = [];
  for (const ids of chunk(Array.from(new Set(broadcast_msg_ids)), COPY_CASCADE_CHUNK)) {
    const rows = await db
      .update(message_model)
      .set({ deleted_at: new Date() })
      .where(
        and(
          inArray(
            message_model.id,
            db
              .select({ id: broadcast_message_copy_model.message_id })
              .from(broadcast_message_copy_model)
              .where(inArray(broadcast_message_copy_model.broadcast_msg_id, ids)),
          ),
          isNull(message_model.deleted_at),
          !is_admin_or_staff ? eq(message_model.sender_id, user_id) : undefined,
        ),
      )
      .returning({ id: message_model.id, chat_id: message_model.chat_id });
    out.push(...rows);
  }
  return out;
};

export {
  create_broadcast_list,
  get_broadcast_list,
  update_broadcast_list,
  delete_broadcast_list,
  get_broadcast_copies,
  handle_broadcast_message_new,
  soft_delete_broadcast_copies,
};
export type { BroadcastListDTO, BroadcastCopyDTO, BroadcastRecipientDTO };
