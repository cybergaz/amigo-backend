// =============================================================================
// FCM health per user (SYNC_V2 §14.13)
// =============================================================================
//   sent  += message:new carried by each successful ws-message push
//   fast  += FCM-path delivered receipts (POST /message/delivered and
//            /delivered/batch — both app builds call them only from their FCM
//            handlers) that arrive within 2 min of the message reaching the
//            server
//   fcm_health = fast / sent over 7 days (capped at 1). Drives the admin page
//   now and the app's OEM card / reliable mode later (§14.8).
//
// "Within 2 min of the push" is measured from messages.created_at (server
// arrival): the push leaves ≤ 4 s later (batch window), or ~10 s later for an
// ack-fallback push, so the error is a few seconds of a 120 s window, and it
// needs no per-push record anywhere.
//
// Cost: nothing per push or receipt but a Map update. Every 15 s one Redis
// pipeline per worker: HINCRBY + EXPIRE per touched user and day, plus the
// all-users day key the admin page reads. Counts from several workers just
// add up. Only while app_settings.sync_v2_net_telemetry is on (the keys live
// on a noeviction Redis: ~1 small hash per active user per day, EX 8 days).
// A crash loses ≤ 15 s of counts — telemetry, not state.
// =============================================================================
import { redis } from "@/config/redis";
import { sync_v2_flags } from "@/services/app-settings.service";
import { k } from "@/cluster/keys";
import { track } from "@/cluster/lifecycle";
import { count } from "@/utils/counters";
import {
  FCM_HEALTH_DAYS,
  FCM_HEALTH_TTL_S,
  fcm_health_ratio,
  is_fast_receipt,
  last_days,
  utc_day,
} from "./fcm-health-core";

export { count_message_new } from "./fcm-health-core";

const FLUSH_EVERY_MS = 15_000;
// Flush early past this many users in the window (memory bound).
const FLUSH_AT_USERS = 20_000;
const PIPE_CHUNK_USERS = 1_000;

// ── accumulator ─────────────────────────────────────────────────────────────

type Acc = { sent: number; fast: number };
let acc = new Map<string, Acc>();

const enabled = () => sync_v2_flags().net_telemetry;

const bump = (uid: string, field: keyof Acc, n: number) => {
  let a = acc.get(uid);
  if (!a) {
    a = { sent: 0, fast: 0 };
    acc.set(uid, a);
  }
  a[field] += n;
  if (acc.size >= FLUSH_AT_USERS) void flush_fcm_health();
};

export const note_fcm_sent = (uid: string, n: number): void => {
  if (n > 0 && uid && enabled()) bump(uid, "sent", n);
};

/** An FCM-path delivered receipt for a message that reached the server at `created_at`. */
export const note_fcm_delivered_receipt = (uid: string, created_at: Date | string | null | undefined): void => {
  if (!uid || !enabled()) return;
  if (is_fast_receipt(created_at)) bump(uid, "fast", 1);
  else count("FCM", "health_slow_receipt");
};

let flushing: Promise<void> | null = null;

export const flush_fcm_health = (): Promise<void> => {
  if (flushing) return flushing;
  if (acc.size === 0) return Promise.resolve();
  const batch = acc;
  acc = new Map();
  const day = utc_day(Date.now());
  flushing = track(
    (async () => {
      const entries = Array.from(batch.entries());
      let total_sent = 0;
      let total_fast = 0;
      for (let i = 0; i < entries.length; i += PIPE_CHUNK_USERS) {
        const pipe = redis.pipeline();
        for (const [uid, a] of entries.slice(i, i + PIPE_CHUNK_USERS)) {
          const key = k.fcm_health(uid, day);
          if (a.sent) pipe.hincrby(key, "sent", a.sent);
          if (a.fast) pipe.hincrby(key, "fast", a.fast);
          pipe.expire(key, FCM_HEALTH_TTL_S);
          total_sent += a.sent;
          total_fast += a.fast;
        }
        if (i + PIPE_CHUNK_USERS >= entries.length) {
          const all = k.fcm_health_all(day);
          if (total_sent) pipe.hincrby(all, "sent", total_sent);
          if (total_fast) pipe.hincrby(all, "fast", total_fast);
          pipe.expire(all, FCM_HEALTH_TTL_S);
        }
        await pipe.exec();
      }
      count("FCM", "health_flushed_users", entries.length);
    })(),
  )
    .catch((err: any) => {
      count("FCM", "health_flush_failed");
      console.error(`[FCM] health flush failed: ${err?.message ?? err}`);
    })
    .finally(() => {
      flushing = null;
    });
  return flushing;
};

/** Boot: periodic flush. The stopper flushes what is left (drain). */
export const start_fcm_health = (): (() => Promise<void>) => {
  const timer = setInterval(() => void flush_fcm_health(), FLUSH_EVERY_MS);
  timer.unref?.();
  return async () => {
    clearInterval(timer);
    await flush_fcm_health();
  };
};

export type FcmHealthDay = { day: string; sent: number; fast: number; health: number | null };

const read_days = async (key_of: (day: string) => string, days: number): Promise<FcmHealthDay[]> => {
  const list = last_days(days);
  const pipe = redis.pipeline();
  for (const d of list) pipe.hmget(key_of(d), "sent", "fast");
  const res = (await pipe.exec()) ?? [];
  return list.map((day, i) => {
    const v = (res[i]?.[1] ?? [null, null]) as (string | null)[];
    const sent = Number(v[0] ?? 0) || 0;
    const fast = Number(v[1] ?? 0) || 0;
    return { day, sent, fast, health: fcm_health_ratio(sent, fast) };
  });
};

/** 7-day FCM health: all users, and one user when given. */
export const read_fcm_health = async (user_id?: string | null, days = FCM_HEALTH_DAYS) => {
  const sum = (rows: FcmHealthDay[]) => {
    const sent = rows.reduce((n, r) => n + r.sent, 0);
    const fast = rows.reduce((n, r) => n + r.fast, 0);
    return { sent, fast, health: fcm_health_ratio(sent, fast), days: rows };
  };
  const all = sum(await read_days(k.fcm_health_all, days));
  const user = user_id ? sum(await read_days((d) => k.fcm_health(user_id, d), days)) : null;
  return { all, user, enabled: enabled() };
};
