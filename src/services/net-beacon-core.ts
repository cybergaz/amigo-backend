// =============================================================================
// Network beacon (SYNC_V2 §14.14) — pure rules + SQL (no config imports)
// =============================================================================
// The app (App A, net-beacon.service.dart) flushes ≤ 4 KB of counters every
// 15 min in the foreground, on pause and from the background worker. No
// content: ids of messages / chats / peers never belong here, and the
// netKey is salted per install. Expected shape (every field optional except
// `app`; unknown fields are kept, within the caps below):
//
//   { v: 1, app: "4.3.0+50", os: "android 13", oem: "xiaomi",
//     sess: "<random per process>", window_s: 900,
//     net:     { "<netKey>": { s, validated, captive, metered, rssi } },
//     rtt:     { p50, p90, p99 },                     // ms
//     carrier: { ws: s, lp: s, none: s },             // seconds per carrier
//     ws:      { attempts, fail: { <kind>: n }, close: { "<code>": n }, ready_ms_p50 },
//     lp:      { req, timeout, err },
//     http:    { err: { dns, timeout, reset, reused_conn_fail, queue_timeout, ... } },
//     reach:   { online: s, captive: s, no_internet: s, server_trouble: s, offline: s },
//     fcm:     { token: bool, rx, last_rx_age_s, rx_lag_p50_ms },
//     bg:      { runs, ok, changed, notif, last_run_age_s },
//     media:   { up_bytes, down_bytes, up_kbps, down_kbps, resumes } }
//
// Server side: shape check + 4 KB cap here; rate limit (1 / user / 60 s) and
// the Redis queue in net-beacon.service.ts; the flusher inserts batches into
// net_beacons; GET /admin/net-health aggregates with net_health_sql.
// =============================================================================
import type postgres from "postgres";

type AnySql = postgres.Sql<{}> | postgres.TransactionSql<{}>;

export const BEACON_MAX_BYTES = 4_096;
const MAX_DEPTH = 4;
const MAX_KEYS = 400;
const MAX_STRING = 200;
const MAX_ARRAY = 50;
const MAX_APP = 40;

export type BeaconVerdict =
  | { ok: true; payload: Record<string, unknown>; app_ver: string }
  | { ok: false; reason: string };

/**
 * Shape check of a parsed beacon. Leaves: finite numbers, short strings,
 * booleans, null; objects/arrays nested ≤ 4 deep; ≤ 400 keys in total.
 * `fcm.token` is reduced to a boolean: the spec means "has a token", and a
 * client that sends the token itself must never get a push credential
 * stored in a telemetry table.
 */
export const validate_beacon = (raw: unknown): BeaconVerdict => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "not_an_object" };
  const app = (raw as Record<string, unknown>).app;
  if (typeof app !== "string" || app.trim() === "" || app.length > MAX_APP) return { ok: false, reason: "bad_app" };
  let keys = 0;
  const walk = (v: unknown, depth: number): string | null => {
    if (v === null || typeof v === "boolean") return null;
    if (typeof v === "number") return Number.isFinite(v) ? null : "bad_number";
    if (typeof v === "string") return v.length <= MAX_STRING ? null : "string_too_long";
    if (depth >= MAX_DEPTH) return "too_deep";
    if (Array.isArray(v)) {
      if (v.length > MAX_ARRAY) return "array_too_long";
      for (const x of v) {
        const e = walk(x, depth + 1);
        if (e) return e;
      }
      return null;
    }
    if (typeof v === "object") {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (++keys > MAX_KEYS) return "too_many_keys";
        if (k.length > 64) return "key_too_long";
        const e = walk(x, depth + 1);
        if (e) return e;
      }
      return null;
    }
    return "bad_value";
  };
  const err = walk(raw, 0);
  if (err) return { ok: false, reason: err };
  const payload = { ...(raw as Record<string, unknown>) };
  const fcm = payload.fcm;
  if (fcm && typeof fcm === "object" && !Array.isArray(fcm) && "token" in fcm) {
    const t = (fcm as Record<string, unknown>).token;
    payload.fcm = { ...(fcm as Record<string, unknown>), token: typeof t === "string" ? t.length > 0 : t === true };
  }
  return { ok: true, payload, app_ver: app.trim() };
};

/** Parse + validate a raw body (bytes already capped by the caller). */
export const parse_beacon_body = (text: string): BeaconVerdict => {
  if (Buffer.byteLength(text, "utf8") > BEACON_MAX_BYTES) return { ok: false, reason: "too_large" };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "bad_json" };
  }
  return validate_beacon(raw);
};

/** What the queue holds per beacon (one Redis LIST element). */
export type QueuedBeacon = { u: string; t: number; ip: string | null; av: string; p: Record<string, unknown> };

export const encode_queued = (b: QueuedBeacon): string => JSON.stringify(b);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const decode_queued = (raw: string): QueuedBeacon | null => {
  try {
    const b = JSON.parse(raw) as QueuedBeacon;
    if (!b || typeof b !== "object" || typeof b.u !== "string" || !UUID_RE.test(b.u)) return null;
    if (typeof b.t !== "number" || !Number.isFinite(b.t) || !b.p || typeof b.p !== "object") return null;
    return b;
  } catch {
    return null;
  }
};

/** One multi-row INSERT (one parameter: the JSON array). Returns rows written. */
export const insert_beacons_sql = async (sql: AnySql, items: QueuedBeacon[]): Promise<number> => {
  if (items.length === 0) return 0;
  const rows = await sql<{ n: number }[]>`
    WITH ins AS (
      INSERT INTO net_beacons (user_id, ts, ip24, app_ver, payload)
      SELECT (x->>'u')::uuid,
             to_timestamp((x->>'t')::double precision / 1000.0),
             x->>'ip',
             left(x->>'av', 40),
             x->'p'
        FROM jsonb_array_elements(${JSON.stringify(items)}::text::jsonb) AS x
      RETURNING 1)
    SELECT count(*)::int AS n FROM ins`;
  return Number(rows[0]?.n ?? 0);
};

/**
 * One retention batch: the oldest ≤ `limit` rows older than `cutoff`. The
 * cutoff goes as ISO text: the app's pg_client is shared with drizzle, whose
 * timestamp serializer rejects a Date parameter.
 */
export const delete_old_beacons_sql = async (sql: AnySql, cutoff: Date, limit: number): Promise<number> => {
  const rows = await sql<{ n: number }[]>`
    WITH del AS (
      DELETE FROM net_beacons
       WHERE id IN (SELECT id FROM net_beacons WHERE ts < ${cutoff.toISOString()}::timestamptz ORDER BY ts LIMIT ${limit}::int)
      RETURNING 1)
    SELECT count(*)::int AS n FROM del`;
  return Number(rows[0]?.n ?? 0);
};

// SUM of every numeric member of the object at `path` (jsonb_each), per key,
// top 50 — for the `{kind: n}` / `{state: seconds}` maps of the beacon.
const sum_map = (sql: AnySql, path: string[]) => sql`
  (SELECT coalesce(json_object_agg(e.key, e.total), '{}'::json) FROM (
     SELECT kv.key, round(sum((kv.value #>> '{}')::float8)::numeric, 1) AS total
       FROM w, jsonb_each(CASE WHEN jsonb_typeof(w.p #> ${sql.array(path)}::text[]) = 'object'
                               THEN w.p #> ${sql.array(path)}::text[] ELSE '{}'::jsonb END) AS kv
      WHERE jsonb_typeof(kv.value) = 'number'
      GROUP BY kv.key ORDER BY 2 DESC LIMIT 50) e)`;

// Numeric leaf at `path`, NULL when missing / not a number.
const num = (sql: AnySql, path: string[]) =>
  sql`(CASE WHEN jsonb_typeof(w.p #> ${sql.array(path)}::text[]) = 'number' THEN (w.p #>> ${sql.array(path)}::text[])::float8 END)`;

const pct = (sql: AnySql, q: number, path: string[]) =>
  sql`(SELECT round((percentile_cont(${q}::float8) WITHIN GROUP (ORDER BY ${num(sql, path)}))::numeric, 1) FROM w)`;

// count by a short string leaf (version, OEM, OS), top 30
const by_text = (sql: AnySql, expr: postgres.PendingQuery<postgres.Row[]>) => sql`
  (SELECT coalesce(json_object_agg(s.k, s.n), '{}'::json) FROM (
     SELECT coalesce(${expr}, '?') AS k, count(*) AS n FROM w GROUP BY 1 ORDER BY 2 DESC LIMIT 30) s)`;

/**
 * GET /admin/net-health aggregation over the last `hours` (one statement; a
 * range on idx_net_beacons_ts). Keys follow the beacon shape above; absent
 * fields simply aggregate to null / {}.
 */
export const net_health_sql = async (sql: AnySql, hours: number): Promise<Record<string, unknown>> => {
  const h = Math.max(1, Math.min(24 * 14, Math.round(hours)));
  const rows = await sql<{ j: Record<string, unknown> }[]>`
    WITH w AS MATERIALIZED (
      SELECT b.user_id, b.app_ver, b.payload AS p FROM net_beacons b
       WHERE b.ts >= now() - make_interval(hours => ${h}::int))
    SELECT json_build_object(
      'beacons', (SELECT count(*) FROM w),
      'users', (SELECT count(DISTINCT user_id) FROM w),
      'by_version', ${by_text(sql, sql`w.app_ver`)},
      'by_oem', ${by_text(sql, sql`lower(w.p->>'oem')`)},
      'by_os', ${by_text(sql, sql`split_part(w.p->>'os', '.', 1)`)},
      'rtt_ms', json_build_object('p50', ${pct(sql, 0.5, ["rtt", "p50"])},
                                  'p90', ${pct(sql, 0.9, ["rtt", "p90"])},
                                  'p99', ${pct(sql, 0.99, ["rtt", "p99"])}),
      'carrier_s', ${sum_map(sql, ["carrier"])},
      'ws', json_build_object('attempts', (SELECT sum(${num(sql, ["ws", "attempts"])}) FROM w),
                              'fail', ${sum_map(sql, ["ws", "fail"])},
                              'close', ${sum_map(sql, ["ws", "close"])},
                              'ready_ms_p50', ${pct(sql, 0.5, ["ws", "ready_ms_p50"])}),
      'lp', ${sum_map(sql, ["lp"])},
      'http_err', ${sum_map(sql, ["http", "err"])},
      'reach_s', ${sum_map(sql, ["reach"])},
      'fcm', json_build_object(
        'with_token', (SELECT count(*) FILTER (WHERE w.p->'fcm'->'token' = 'true'::jsonb) FROM w),
        'rx', (SELECT sum(${num(sql, ["fcm", "rx"])}) FROM w),
        'last_rx_age_s_p50', ${pct(sql, 0.5, ["fcm", "last_rx_age_s"])},
        'rx_lag_ms_p50', ${pct(sql, 0.5, ["fcm", "rx_lag_p50_ms"])}),
      'bg', json_build_object(
        'runs', (SELECT sum(${num(sql, ["bg", "runs"])}) FROM w),
        'ok', (SELECT sum(${num(sql, ["bg", "ok"])}) FROM w),
        'notif', (SELECT sum(${num(sql, ["bg", "notif"])}) FROM w),
        'last_run_age_s_p50', ${pct(sql, 0.5, ["bg", "last_run_age_s"])}),
      'media', json_build_object(
        'up_bytes', (SELECT sum(${num(sql, ["media", "up_bytes"])}) FROM w),
        'down_bytes', (SELECT sum(${num(sql, ["media", "down_bytes"])}) FROM w),
        'up_kbps_p50', ${pct(sql, 0.5, ["media", "up_kbps"])},
        'down_kbps_p50', ${pct(sql, 0.5, ["media", "down_kbps"])},
        'resumes', (SELECT sum(${num(sql, ["media", "resumes"])}) FROM w))
    ) AS j`;
  const j = rows[0]?.j ?? {};
  // carrier share (§14.14 "carrier share"): seconds per carrier / total.
  const carrier = (j.carrier_s ?? {}) as Record<string, number>;
  const total = Object.values(carrier).reduce((a, b) => a + Number(b || 0), 0);
  const share: Record<string, number> = {};
  if (total > 0) for (const [c, s] of Object.entries(carrier)) share[c] = Math.round((Number(s) / total) * 1000) / 1000;
  return { window_h: h, ...j, carrier_share: share };
};
