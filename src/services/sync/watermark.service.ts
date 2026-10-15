// =============================================================================
// Watermarks: the single writer of chat_members.read_seq / delivered_seq
// (SYNC_V2_PROTOCOL.md §3.7, R1a step (b) "dual-write apply_receipts", R1b).
// =============================================================================
// shadow: every legacy receipt input is ALSO written here, by the
// authenticated user id, while the legacy paths (Redis receipts / unread,
// message_info, conversation:join + status:ack frames) keep serving clients
// unchanged — "writes PG, serves Redis".
//
// on (+ the backfill / index markers, flags-core derived_ready): the PG
// watermarks are the truth. Old apps' read frames are APPLIED (awaited) and
// every legacy effect — message_info read rows, conversation:join /
// status:ack to the senders, reset_unread, pending drains — is derived from
// the committed prev/new windows (receipt-effects.ts), so a replayed or stale
// frame advances and re-broadcasts nothing. The mins runner emits chat:wm
// (proto-2 sockets) and a reconcile sweep re-queues chats whose mins lag.
//
// off: every note_* is a no-op that costs nothing.
//
// Round trips added (shadow; none on a request's critical path — every
// write is fire-and-forget, tracked for the drain):
//   conversation:join / mark_read  +1 statement (read)
//   message:status:ack read         +1 statement per frame (all its chats)
//   status:ack delivered / POST /message/delivered(/batch)
//                                   0 per receipt; ≤ 1 statement per user per
//                                   ~1 s window (DeliveredCoalescer)
//   clear chat                      +1 statement (apply_clear)
//   a DM that advanced              +1 statement (inline mins refresh)
//   a group whose mins may move     +1 Redis SADD; the runner refreshes up
//                                   to 200 dirty chats per statement / 1 s
// on, instead of the legacy relays (harness r1b_app.ts counts):
//   conversation:join   1 statement awaited (apply) + 1 after it (windows:
//                       message_info rows + senders + last id + delivered
//                       rows in ONE) + the pending drains; legacy was 3
//   status:ack read     apply awaited + windows + sender drains (legacy: the
//                       sender lookup + drains)
//   delivered           coalesced apply + windows per user per ~1 s
//   reconcile sweep     1 read per 10 min, one worker (job singleton)
// =============================================================================
import { pg_client } from "@/config/db";
import { sync_v2_flags } from "@/services/app-settings.service";
import { dualwrite_active } from "./flags-core";
import { apply_clear } from "./seq-queries";
import {
  apply_receipts_sql,
  is_uuid,
  mins_may_move,
  refresh_mins_checked,
  refresh_mins_sql,
  type ReceiptInput,
  type ReceiptOutcome,
} from "./write-queries";
import { DeliveredCoalescer } from "./receipt-coalescer";
import { count, observe_ms } from "@/utils/counters";
import { track } from "@/cluster/lifecycle";
import { run_pg_singleton_sql } from "@/cluster/jobs";
import { rfast, deadline } from "@/cluster/redis-fast";
import { k } from "@/cluster/keys";
import { select_reconcile_chats } from "./write-queries";
import { emit_chat_wm, emit_dm_wm, run_receipt_effects, window_effects_active } from "./receipt-effects";

const DELIVERED_FLUSH_MS = 1_000;
const DELIVERED_FLUSH_CONCURRENCY = 4;
const MINWM_TICK_MS = 1_000;
const MINWM_BATCH = 200;
// §3.7 step 1: the reconcile sweep re-queues recently active chats whose
// mins lag the last message — a lost dirty set (Redis flush, a crash between
// commit and SADD) heals within this period.
const MINWM_RECONCILE_MS = 10 * 60_000;
const MINWM_RECONCILE_WINDOW_S = 86_400;
const MINWM_RECONCILE_MAX = 2_000;
const REDIS_DEADLINE_MS = 1_000;

const is_on = (): boolean => dualwrite_active(sync_v2_flags());

const report = (o: ReceiptOutcome, join: boolean): void => {
  count("RCPT", o.status);
  if (o.seq_head !== null && ((o.r ?? 0) > o.seq_head || (o.d ?? 0) > o.seq_head)) {
    count("RCPT", "clamped_to_head");
  }
  if (join && o.seq_head !== null && o.status !== "rejected") {
    count("RCPT", o.r === null ? "legacy_join_unknown" : "legacy_join_mapped");
  }
};

/**
 * Mins upkeep after a commit (§3.7 step 1): a DM is refreshed inline (cheap,
 * and a DM's "others" is exactly the peer); a group is marked dirty only when
 * the member was at or below the second-lowest value. Broadcast lists have no
 * mins (§3.8).
 */
const after_apply = (outcomes: ReceiptOutcome[]): void => {
  const dms: string[] = [];
  const dirty: string[] = [];
  for (const o of outcomes) {
    if (o.status !== "applied") continue;
    if (o.chat_type === "dm") dms.push(o.chat_id);
    else if (o.chat_type !== "broadcast" && mins_may_move(o)) dirty.push(o.chat_id);
  }
  if (dms.length > 0) {
    track(
      refresh_mins_sql(pg_client, dms)
        .then((n) => count("RCPT", "min_refresh", n))
        .catch((err) => console.error(`[RCPT] dm mins refresh failed: ${err?.message ?? err}`)),
    );
  }
  mark_mins_dirty(dirty);
};

const mark_mins_dirty = (chat_ids: string[]): void => {
  if (chat_ids.length === 0) return;
  track(
    deadline(rfast.sadd(k.minwm_dirty(), ...chat_ids), REDIS_DEADLINE_MS, "minwm sadd")
      .then(() => count("RCPT", "min_dirty", chat_ids.length))
      .catch((err) => console.error(`[RCPT] minwm dirty add failed: ${err?.message ?? err}`)),
  );
};

/**
 * apply_receipts(auth_user, items) — the one writer (§3.7). Callers pass the
 * AUTHENTICATED id only. Never call it with payload ids. Rejects on a DB
 * error (callers that fire-and-forget catch it).
 */
export const apply_receipts = async (
  user_id: string,
  items: ReceiptInput[],
  // at: the receipt time for the legacy message_info rows (window effects);
  // defaults to now. reader_drained: a legacy input — it drained the
  // reader's pending message:new keys for its acked ids on arrival
  // (status:ack, FCM delivered) or acked no id (join / mark_read), so the
  // window effects must not drain the reader's keys for the whole window.
  // legacy_delivered: per-id delivered acks whose handler relays the acked
  // ids itself; the window adds no delivered frames / sender drains.
  opts: { join?: boolean; at?: Date; reader_drained?: boolean; legacy_delivered?: boolean } = {},
): Promise<ReceiptOutcome[]> => {
  const clean = items
    .filter((i) => is_uuid(i.chat_id))
    .map((i) => ({
      ...i,
      read_ids: i.read_ids?.filter(is_uuid),
      delivered_ids: i.delivered_ids?.filter(is_uuid),
    }));
  if (!is_uuid(user_id) || clean.length === 0) return [];
  const t0 = performance.now();
  let outcomes: ReceiptOutcome[];
  try {
    outcomes = await apply_receipts_sql(pg_client, user_id, clean);
  } catch (err) {
    // 40P01 against a membership change on the same rows: retry once, the
    // statement is idempotent (GREATEST).
    if ((err as { code?: string })?.code !== "40P01") throw err;
    count("RCPT", "deadlock_retry");
    outcomes = await apply_receipts_sql(pg_client, user_id, clean);
  }
  count("RCPT", "pg_writes");
  observe_ms("RCPT", "apply_ms", performance.now() - t0);
  for (const o of outcomes) report(o, opts.join === true);
  after_apply(outcomes);
  // sync_v2 'on' (derived state ready): the §3.7 legacy effects come from
  // the committed windows (receipt-effects.ts); the legacy handlers then
  // skip their own relays. Every caller — WS / REST legacy inputs, the
  // delivered coalescer, /chat/sync/intents — gets them the same way.
  if (window_effects_active()) {
    run_receipt_effects(user_id, outcomes, opts.at ?? new Date(), {
      reader_drain: opts.reader_drained !== true,
      delivered_relay: opts.legacy_delivered !== true,
    });
    emit_dm_wm(user_id, outcomes);
  }
  return outcomes;
};

const fire = (label: string, p: Promise<unknown>): void => {
  track(
    p.catch((err: any) => {
      count("RCPT", "apply_failed");
      console.error(`[RCPT] ${label} failed: ${err?.code ?? ""} ${err?.message ?? err}`);
    }),
  );
};

// ── Legacy inputs (§3.7 table) ──────────────────────────────────────────────

/**
 * conversation:join / conversation:mark_read with last_read_msg_id (old app):
 * read = seq(last_read_msg_id) if that id is in this chat; = seq_head when it
 * is the chat's current last_msg_id; an unknown id is a no-op
 * ([RCPT] legacy_join_unknown). Never "head at processing" for an arbitrary
 * frame: a replayed outbox frame would mark unseen messages read.
 */
export const note_legacy_read = (user_id: string, chat_id: string, last_read_msg_id: string | undefined | null): void => {
  // With window effects on, the handler applies the read itself, awaited
  // (apply_legacy_read): a second fire-and-forget apply would double them.
  if (!last_read_msg_id || !is_on() || window_effects_active()) return;
  if (!is_uuid(last_read_msg_id) || !is_uuid(chat_id)) return;
  fire("legacy read", apply_receipts(user_id, [{ chat_id, read_ids: [last_read_msg_id], join: true }], { join: true }));
};

/**
 * sync_v2 'on' (window effects): conversation:join / mark_read from an old
 * app, APPLIED (awaited) instead of dual-written. `read_seq` (new clients,
 * optional) is taken exactly; otherwise the §3.7 legacy mapping of
 * last_read_msg_id. Returns the outcome, or null when the legacy path must
 * run instead (bad ids, chat not numbered → 425, DB error).
 */
export const apply_legacy_read = async (
  user_id: string,
  chat_id: string,
  last_read_msg_id: string | undefined | null,
  read_seq: unknown,
  at: Date,
): Promise<ReceiptOutcome | null> => {
  if (!is_uuid(chat_id) || !is_uuid(user_id)) return null;
  const seq = typeof read_seq === "number" && Number.isFinite(read_seq) && read_seq >= 0 ? Math.floor(read_seq) : null;
  const ids = last_read_msg_id && is_uuid(last_read_msg_id) ? [last_read_msg_id] : [];
  if (seq === null && ids.length === 0) return null;
  // A newer read for this chat supersedes a pending unknown-id retry.
  cancel_unknown_read(user_id, chat_id);
  try {
    const [o] = await apply_receipts(
      user_id,
      [{ chat_id, read_seq: seq, read_ids: ids, join: ids.length > 0 }],
      // reader_drained: a join names no delivered id; delivered follows read,
      // but the device may have missed rows below last_read_msg_id (legacy
      // never drained anything on a join), so their pending copies stay.
      { join: ids.length > 0, at, reader_drained: true },
    );
    if (!o || o.status === "retry") {
      count("RCPT", "v2_read_fallback");
      return null;
    }
    return o;
  } catch (err: any) {
    count("RCPT", "apply_failed");
    console.error(`[RCPT] legacy read apply failed: ${err?.code ?? ""} ${err?.message ?? err}`);
    return null;
  }
};

// ── Unknown-id legacy reads ─────────────────────────────────────────────────
// An old app's join / mark_read can name an id the server has not stored
// yet: getLatestNonSystemMessageId returns the reader's OWN reply while the
// GC is still resending it (reconnect re-join, "Mark as read"), and the vital
// outbox LWW-supersedes the earlier join. §3.7 maps such an id to nothing
// (never "head at processing": a replayed frame would mark unseen rows read),
// so the read would be lost and the badge stay (legacy reset it to 0). The
// read is retried, per (user, chat), a few times while the reply lands; a
// newer read for the chat replaces it. In-memory and best effort: the
// stored reply's own window, or the next read, repairs a lost retry.
const UNKNOWN_READ_RETRY_MS = [3_000, 15_000, 60_000] as const;
const UNKNOWN_READ_MAX = 10_000;
const unknown_reads = new Map<string, ReturnType<typeof setTimeout>>();

const cancel_unknown_read = (user_id: string, chat_id: string): void => {
  const key = `${user_id}|${chat_id.toLowerCase()}`;
  const t = unknown_reads.get(key);
  if (t) {
    clearTimeout(t);
    unknown_reads.delete(key);
  }
};

export const retry_unknown_legacy_read = (user_id: string, chat_id: string, msg_id: string, at: Date): void => {
  if (!is_uuid(user_id) || !is_uuid(chat_id) || !is_uuid(msg_id)) return;
  const key = `${user_id}|${chat_id.toLowerCase()}`;
  cancel_unknown_read(user_id, chat_id);
  if (unknown_reads.size >= UNKNOWN_READ_MAX) {
    count("RCPT", "legacy_read_retry_overflow");
    return;
  }
  let attempt = 0;
  const schedule = () => {
    const t = setTimeout(() => {
      unknown_reads.delete(key);
      if (workers_stopped) return;
      track(
        apply_receipts(user_id, [{ chat_id, read_ids: [msg_id], join: true }], { join: true, at, reader_drained: true })
          .then(([o]) => {
            if (o && o.status === "noop" && o.r === null) {
              if (++attempt < UNKNOWN_READ_RETRY_MS.length && !unknown_reads.has(key)) schedule();
              else count("RCPT", "legacy_read_retry_gave_up");
            } else {
              count("RCPT", "legacy_read_retry_applied");
            }
          })
          .catch((err: any) => {
            count("RCPT", "apply_failed");
            console.error(`[RCPT] unknown-id read retry failed: ${err?.code ?? ""} ${err?.message ?? err}`);
          }),
      );
    }, UNKNOWN_READ_RETRY_MS[attempt]);
    (t as { unref?: () => void }).unref?.();
    unknown_reads.set(key, t);
  };
  count("RCPT", "legacy_read_retry_scheduled");
  schedule();
};

/**
 * sync_v2 'on' (window effects): the READ acks of a message:status:ack,
 * applied (awaited). Returns the chat ids the window effects now own; the
 * caller relays the rest (not numbered / failed) the legacy way.
 */
export const apply_status_reads = async (
  user_id: string,
  reads: { chat_id: string; msg_ids: string[] }[],
  at: Date,
): Promise<Set<string>> => {
  const done = new Set<string>();
  const items = reads
    .filter((g) => is_uuid(g.chat_id))
    .map((g) => ({ chat_id: g.chat_id, read_ids: g.msg_ids }));
  if (items.length === 0) return done;
  try {
    for (const o of await apply_receipts(user_id, items, { at, reader_drained: true })) {
      if (o.status !== "retry") done.add(o.chat_id.toLowerCase());
    }
  } catch (err: any) {
    count("RCPT", "apply_failed");
    console.error(`[RCPT] status read apply failed: ${err?.code ?? ""} ${err?.message ?? err}`);
  }
  return done;
};

const coalescer = new DeliveredCoalescer();
let workers_stopped = true;

/**
 * message:status:ack (WS or POST /message/status-ack): read → written now
 * (max seq of the acked ids, delivered follows); delivered-only → coalesced.
 */
export const note_status_ack = (
  user_id: string,
  acks: { chat_id: string; msg_ids: string[]; status: string[] }[] | undefined,
): void => {
  if (!acks?.length || !is_on()) return;
  // Window effects on: the handler applies the reads itself (awaited,
  // apply_status_reads); only the delivered acks are coalesced here.
  const effects = window_effects_active();
  const reads: ReceiptInput[] = [];
  for (const g of acks) {
    if (!g || !is_uuid(g.chat_id) || !Array.isArray(g.msg_ids) || g.msg_ids.length === 0) continue;
    const status = Array.isArray(g.status) ? g.status : [];
    if (status.includes("read")) {
      if (!effects) reads.push({ chat_id: g.chat_id, read_ids: g.msg_ids });
    } else if (status.includes("delivered")) {
      note_delivered(user_id, g.chat_id, g.msg_ids);
    }
  }
  if (reads.length > 0) fire("status read", apply_receipts(user_id, reads));
};

/** Delivered ids (status:ack, POST /message/delivered(/batch)) → coalesced. */
export const note_delivered = (user_id: string, chat_id: string, ids: string[]): void => {
  if (!is_on() || !is_uuid(chat_id)) return;
  const valid = ids.filter(is_uuid);
  if (valid.length === 0) return;
  if (workers_stopped) {
    // Draining (or the workers never started, e.g. a script): no timer will
    // flush the buffer, so write through.
    fire("delivered (direct)", apply_receipts(user_id, [{ chat_id, delivered_ids: valid }], { reader_drained: true, legacy_delivered: true }));
    return;
  }
  coalescer.add(user_id, chat_id, valid);
  if (coalescer.size >= coalescer.soft_limit) void flush_delivered();
};

/**
 * Legacy clear (no upto_seq): cleared_seq = seq_head at processing, read and
 * delivered follow (§3.12). The legacy cleared_at write stays in
 * clear_chat_for_user; apply_clear only moves it forward.
 */
export const note_clear = (user_id: string, chat_id: string): void => {
  if (!is_on() || !is_uuid(chat_id) || !is_uuid(user_id)) return;
  fire("clear", apply_clear(pg_client, user_id, chat_id, null).then((r) => {
    count("RCPT", r ? "clear_applied" : "clear_noop");
    count("RCPT", "pg_writes");
    // A clear raises read/delivered to head, so this member may leave the
    // bottom two; clears are rare, so always let the runner recompute.
    if (r) mark_mins_dirty([chat_id]);
  }));
};

// ── Workers: delivered flush + mins runner ──────────────────────────────────

let flushing: Promise<void> | null = null;

const flush_delivered = (): Promise<void> => {
  if (flushing) return flushing;
  const run = async (): Promise<void> => {
    const batch = coalescer.drain();
    if (batch.size === 0) return;
    const users = Array.from(batch.entries());
    let next = 0;
    const lane = async () => {
      while (next < users.length) {
        const [user_id, items] = users[next++]!;
        try {
          // Every coalesced input (status:ack, POST /message/delivered)
          // drained the reader's keys for its ids on arrival.
          await apply_receipts(user_id, items, { reader_drained: true, legacy_delivered: true });
        } catch (err: any) {
          count("RCPT", "apply_failed");
          console.error(`[RCPT] delivered flush failed user=${user_id}: ${err?.code ?? ""} ${err?.message ?? err}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(DELIVERED_FLUSH_CONCURRENCY, users.length) }, lane));
  };
  // The reset is chained AFTER the assignment on purpose. With a
  // try/finally inside an async IIFE, an empty buffer returns before the
  // first await, so the finally ran synchronously — before `flushing` was
  // assigned — and left `flushing` pointing at a settled promise forever:
  // every later flush returned it and the buffer was never written again.
  flushing = run().finally(() => {
    flushing = null;
  });
  return flushing;
};

let minwm_running = false;

// One tick of the mins runner (§3.7): SPOP ≤ 200 dirty chats, refresh them in
// one statement under the 'minwm_runner' singleton. If another worker holds
// the job, the ids go back into the set. R1b adds the chat:wm emit here.
const run_minwm_once = async (): Promise<number> => {
  if (minwm_running || !is_on()) return 0;
  minwm_running = true;
  try {
    const raw = await deadline(rfast.spop(k.minwm_dirty(), MINWM_BATCH), REDIS_DEADLINE_MS, "minwm spop");
    const ids = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter(is_uuid);
    if (ids.length === 0) return 0;
    const res = await run_pg_singleton_sql("minwm_runner", (tx) => refresh_mins_checked(tx, ids));
    if (res === undefined) {
      await deadline(rfast.sadd(k.minwm_dirty(), ...ids), REDIS_DEADLINE_MS, "minwm requeue");
      return 0;
    }
    count("RCPT", "min_refresh", res.refreshed);
    if (res.regressed.length > 0) {
      count("RCPT", "min_regress", res.regressed.length);
      console.error(`[RCPT] min_regress chats=${res.regressed.slice(0, 10).join(",")}`);
    }
    // §3.7: chat:wm to proto-2 sockets for chats whose mins rose (a no-op
    // unless mode 'on' and sync_v2_proto_lease). Off the runner's critical
    // path so the next tick is not held by a slow delivery.
    track(emit_chat_wm(res.before, res.after).catch((err: any) =>
      console.error(`[RCPT] chat:wm emit failed: ${err?.message ?? err}`)));
    return res.refreshed;
  } catch (err: any) {
    console.error(`[RCPT] minwm runner failed: ${err?.message ?? err}`);
    return 0;
  } finally {
    minwm_running = false;
  }
};

let reconcile_running = false;

// The 10-min reconcile sweep (§3.7 step 1). One worker runs it (job
// singleton); the selected chats go into the dirty set and the mins runner
// refreshes them (emitting chat:wm where they rose). Read-only on PG.
const run_minwm_reconcile_once = async (): Promise<number> => {
  if (reconcile_running || !is_on()) return 0;
  reconcile_running = true;
  try {
    const ids = await run_pg_singleton_sql("minwm_reconcile", (tx) =>
      select_reconcile_chats(tx, MINWM_RECONCILE_WINDOW_S, MINWM_RECONCILE_MAX));
    if (!ids || ids.length === 0) return 0;
    for (let i = 0; i < ids.length; i += 500) {
      await deadline(rfast.sadd(k.minwm_dirty(), ...ids.slice(i, i + 500)), REDIS_DEADLINE_MS, "minwm reconcile");
    }
    count("RCPT", "min_reconcile_queued", ids.length);
    return ids.length;
  } catch (err: any) {
    console.error(`[RCPT] minwm reconcile failed: ${err?.message ?? err}`);
    return 0;
  } finally {
    reconcile_running = false;
  }
};

/** Start the delivered flush, the mins runner and its reconcile sweep. Returns the drain stopper. */
export const start_watermark_workers = (): (() => Promise<void>) => {
  workers_stopped = false;
  const flush_timer = setInterval(() => void flush_delivered(), DELIVERED_FLUSH_MS);
  const minwm_timer = setInterval(() => void run_minwm_once(), MINWM_TICK_MS);
  const reconcile_timer = setInterval(() => void run_minwm_reconcile_once(), MINWM_RECONCILE_MS);
  return async () => {
    workers_stopped = true;
    for (const t of unknown_reads.values()) clearTimeout(t);
    unknown_reads.clear();
    clearInterval(flush_timer);
    clearInterval(minwm_timer);
    clearInterval(reconcile_timer);
    // Whatever is buffered is written now; later receipts write through.
    await flush_delivered();
  };
};

export const watermark_stats = () => ({
  delivered_buffered_ids: coalescer.size,
  delivered_buffered_users: coalescer.users,
});

export { run_minwm_once, run_minwm_reconcile_once, flush_delivered };
