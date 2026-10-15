// =============================================================================
// Sync v2 read API: app glue (SYNC_V2_PROTOCOL.md §3.9, §4.2)
// =============================================================================
// heads, delta / tail / backward / mods, chats, resolve. Each call is ONE
// statement on the hot path (chats: two, run in parallel). The routes
// (routes/sync.routes.ts) apply the auth guard, the Sync v2 gate and
// admission control before any of this runs.
// =============================================================================
import { pg_client } from "@/config/db";
import { count, observe_ms } from "@/utils/counters";
import {
  SYNC_PROTO,
  etag_matches,
  finalize_mods,
  finalize_page,
  heads_etag,
  type DeltaParams,
} from "./read-core";
import { chat_members_sql, chats_sql, delta_sql, heads_sql, resolve_sql } from "./read-queries";

export type Served =
  | { status: 200; body: Record<string, unknown>; etag?: string }
  | { status: 304; etag: string }
  | { status: 403 | 404 | 425; body: Record<string, unknown> };

const fail = (status: 403 | 404 | 425, reason: string, message: string): Served => ({
  status,
  body: { success: false, code: status, message, reason },
});

// ── GET /chat/sync/heads ─────────────────────────────────────────────────────

/**
 * Absolute per-chat state. `If-None-Match` equal to the current etag → 304
 * (same single statement; nothing else is sent). The etag also travels in the
 * body for clients whose HTTP stack drops the header.
 */
export const get_heads = async (
  user_id: string,
  opts: { stubs_after: number | null; if_none_match?: string | null },
): Promise<Served> => {
  const t0 = performance.now();
  const h = await heads_sql(pg_client, user_id, { stubs_after: opts.stubs_after });
  const etag = heads_etag(h.chats);
  observe_ms("HEADS", "ms", performance.now() - t0);
  if (etag_matches(opts.if_none_match, etag)) {
    count("HEADS", "304");
    return { status: 304, etag };
  }
  count("HEADS", "full");
  return {
    status: 200,
    etag,
    body: {
      success: true,
      code: 200,
      data: {
        proto: SYNC_PROTO,
        sync_proto: SYNC_PROTO,
        server_time: h.server_time,
        resp_ver: h.resp_ver,
        etag,
        full: true,
        chats: h.chats,
      },
    },
  };
};

// ── GET /chat/sync/:chat_id ──────────────────────────────────────────────────

export const get_chat_delta = async (user_id: string, chat_id: string, p: DeltaParams): Promise<Served> => {
  const t0 = performance.now();
  const raw = await delta_sql(pg_client, user_id, chat_id, p);
  observe_ms("DELTA", "ms", performance.now() - t0);
  if (!raw.found) return fail(404, "chat_not_found", "Conversation not found");
  if (raw.access === "none") return fail(403, "not_a_member", "You are not a member of this conversation");
  if (raw.seq_head === null) {
    // Not numbered yet (the backfill marker says it should be): transient.
    return fail(425, "chat_not_numbered", "Conversation is not numbered yet; retry later");
  }
  count("DELTA", raw.mode);

  const shell = raw.access === "shell";
  const data: Record<string, unknown> = {
    proto: SYNC_PROTO,
    sync_proto: SYNC_PROTO,
    server_time: raw.server_time,
    resp_ver: raw.resp_ver,
    chat_id,
    chat_type: raw.chat_type,
    mode: raw.mode,
    status: raw.status,
    hidden: raw.hidden_chat,
    seq_head: raw.seq_head,
    last_seq: shell ? null : raw.last_seq,
    read_seq: raw.read_seq,
    delivered_seq: raw.delivered_seq,
    joined_seq: raw.joined_seq,
    cleared_seq: raw.cleared_seq,
    left_seq: raw.left_seq,
    floor_seq: raw.floor_seq,
    roster_seq: raw.roster_seq,
    pin: raw.pin,
    settings: raw.settings,
  };

  if (raw.mode === "mods") {
    const m = finalize_mods(raw.mods, raw.seq_head);
    Object.assign(data, { rows: [], ...m, through_seq: raw.seq_head, has_more: false, floor: false });
    count("DELTA", "mods_rows", m.mods.length);
  } else {
    const page = finalize_page(raw.mode, raw.rows, p.limit, raw.seq_head, raw.floor_seq, p.before);
    Object.assign(data, {
      rows: page.rows,
      through_seq: page.through_seq,
      through_lo: page.through_lo,
      floor: page.floor,
      has_more: page.has_more,
    });
    if (raw.mode === "tail" && p.since !== null) {
      const m = finalize_mods(raw.mods, raw.seq_head);
      Object.assign(data, m);
      count("DELTA", "mods_rows", m.mods.length);
    }
    if (page.has_more) count("DELTA", "pages_cut");
  }
  return { status: 200, body: { success: true, code: 200, data } };
};

// ── POST /chat/sync/chats ────────────────────────────────────────────────────

export const get_sync_chats = async (user_id: string, ids: string[]): Promise<Served> => {
  const [chats, members] = await Promise.all([
    chats_sql(pg_client, user_id, ids),
    chat_members_sql(pg_client, user_id, ids),
  ]);
  const by_chat = new Map<string, Record<string, unknown>[]>();
  for (const m of members) {
    const list = by_chat.get(String(m.chat_id)) ?? [];
    list.push(m);
    by_chat.set(String(m.chat_id), list);
  }
  for (const c of chats) {
    if (c.type === "group" || c.type === "community_group") c.members = by_chat.get(String(c.conversationId)) ?? [];
  }
  return {
    status: 200,
    body: { success: true, code: 200, data: { proto: SYNC_PROTO, server_time: new Date().toISOString(), chats } },
  };
};

// ── POST /chat/sync/resolve ──────────────────────────────────────────────────

export const resolve_messages = async (user_id: string, ids: string[]): Promise<Served> => {
  const found = await resolve_sql(pg_client, user_id, ids);
  const have = new Set(found.map((f) => f.id));
  const missing = ids.filter((id) => !have.has(id));
  count("SYNC", "resolve_missing", missing.length);
  return {
    status: 200,
    body: { success: true, code: 200, data: { proto: SYNC_PROTO, server_time: new Date().toISOString(), found, missing } },
  };
};
