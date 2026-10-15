// =============================================================================
// Sync v2 flags and markers: pure parsing (SYNC_V2_PROTOCOL.md §3.4 "Flag",
// §9 row 2 (b)/(h), §10). No db / redis imports, so tests and scripts can use
// it. The cached loader lives in services/app-settings.service.ts.
// =============================================================================
import { SYNC_V2_KEYS } from "./seq-queries";

// Global mode (app_settings.sync_v2):
//   off    — default. The R1a structural changes that are keyed on database
//            state stay active (they are no-ops until a chat is numbered):
//            pointer-writer guards, per-chat bulk deletes, the sweeper
//            rewrite, has_hidden. Nothing else: no receipt dual-write, no
//            shadow comparison, no extra round trips.
//   shadow — (h): receipts are dual-written to the PG watermarks (+ mins),
//            the sync_v2_dualwrite marker is written, and derived unread is
//            computed and compared against what is served ([UNREAD-SHADOW]).
//            Nothing a client can see changes.
//   on     — R1b's switch. In R1a it is shadow plus server-time expiry; the
//            R1b build gives it the rest of its meaning (derived unread,
//            syncProto, /chat/sync/*).
export type SyncV2Mode = "off" | "shadow" | "on";

export type SyncV2Flags = {
  mode: SyncV2Mode;
  // §3.10: persist member-visible conversation actions as type='system' rows.
  system_rows: boolean;
  // §3.13: honour ?proto=2 / v1-poll deletes for the proto:{uid} lease.
  // Nothing reads the lease before R1b; it is plumbing only.
  proto_lease: boolean;
  // §3.10: expires_at = server time + duration instead of client sent_at +
  // duration. Also implied by mode 'on'.
  server_expiry: boolean;
  // §5.14: share of users (FNV bucket, read-core rollout_bucket) that are
  // advertised syncProto 2 and let through the /chat/sync/* gate. 0..100,
  // default 0: flipping the mode to 'on' alone exposes v2 to nobody.
  rollout_pct: number;
  // F / R1b: a message:new delivered over a FOREGROUND WebSocket that is not
  // acked "delivered" within ~10 s gets a normal-priority FCM data push
  // (services/fcm-ack-fallback.ts). Off by default: it adds pushes for
  // 4.2.2 too, so it is switched on after the test env run.
  ack_fallback: boolean;
  // §14.13 FCM health counters (Redis fcm:h:*) + §14.14 beacon intake and
  // its PG flusher. Off by default: new Redis keys on a noeviction Redis and
  // a new table; the beacon also needs the net_beacons marker.
  net_telemetry: boolean;
  // §14.11 chunked resumable uploads (POST /api/media/upload/init, PUT/HEAD/
  // GET/DELETE /api/media/upload/:id, POST …/complete). Off by default: the
  // endpoints answer 404 (what an old backend answers, so the app keeps the
  // single-request route). Also needs the media_uploads marker.
  chunked_upload: boolean;
  // §14.7 item 5: keep the client-made inline attachments[i].thumb (~2 KB
  // base64 each) at ingress. Off by default and the kill switch: off drops
  // it there (thumb_url stays), because every relayed thumb is copied into
  // live frames, history, sync rows and the chat list on a noeviction Redis
  // and PG. Switched on with the app build that renders thumbs.
  inline_thumbs: boolean;
  markers: {
    schema: boolean;
    triggers: boolean;
    backfill: boolean;
    indexes_post: boolean;
    dualwrite: boolean;
    code_deployed: boolean;
    // 20261023-net-beacons: the net_beacons table exists.
    net_beacons: boolean;
    // 20261024-media-uploads: the media_uploads table exists.
    media_uploads: boolean;
  };
  // false until the first successful load (defaults are the safe values).
  loaded: boolean;
};

export const DEFAULT_SYNC_V2_FLAGS: SyncV2Flags = Object.freeze({
  mode: "off",
  system_rows: false,
  proto_lease: false,
  server_expiry: false,
  rollout_pct: 0,
  ack_fallback: false,
  net_telemetry: false,
  chunked_upload: false,
  inline_thumbs: false,
  markers: Object.freeze({
    schema: false,
    triggers: false,
    backfill: false,
    indexes_post: false,
    dualwrite: false,
    code_deployed: false,
    net_beacons: false,
    media_uploads: false,
  }),
  loaded: false,
}) as SyncV2Flags;

export const parse_mode = (v: unknown): SyncV2Mode => {
  const s = typeof v === "string"
    ? v.trim().toLowerCase()
    : v && typeof v === "object" && typeof (v as { mode?: unknown }).mode === "string"
      ? String((v as { mode: string }).mode).trim().toLowerCase()
      : "";
  return s === "shadow" || s === "on" ? s : "off";
};

// A boolean FLAG must be explicitly on: true, 1, "1", "on", "true", "yes" or
// {enabled: true}. Anything else (absent, null, "false", typos) is off, so a
// malformed admin write can never switch a behaviour on.
export const flag_on = (v: unknown): boolean => {
  if (v === true || v === 1) return true;
  if (typeof v === "string") return ["1", "on", "true", "yes"].includes(v.trim().toLowerCase());
  if (v && typeof v === "object") return (v as { enabled?: unknown }).enabled === true;
  return false;
};

// A MARKER is on when its row exists and its value is not null / false / 0 /
// "0" / "off" / "" — the exact rule of scripts/lib/sync-v2.ts marker_on, so
// markers written by the ledger scripts as 1 or {done, at, rows} all count.
export const marker_on = (v: unknown): boolean => {
  if (v === undefined || v === null || v === false || v === 0) return false;
  if (typeof v === "string" && (v === "" || v === "0" || v.toLowerCase() === "off")) return false;
  return true;
};

// A percentage: a number (or numeric string) clamped to 0..100. Anything else
// — absent, null, typos — is 0, so a malformed write exposes nobody.
export const parse_pct = (v: unknown): number => {
  const raw = v && typeof v === "object" && "pct" in (v as object) ? (v as { pct: unknown }).pct : v;
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw.trim()) : NaN;
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
};

export const parse_sync_v2_flags = (rows: { key: string; value: unknown }[]): SyncV2Flags => {
  const m = new Map(rows.map((r) => [r.key, r.value]));
  return {
    mode: parse_mode(m.get(SYNC_V2_KEYS.mode)),
    system_rows: flag_on(m.get(SYNC_V2_KEYS.system_rows)),
    proto_lease: flag_on(m.get(SYNC_V2_KEYS.proto_lease)),
    server_expiry: flag_on(m.get(SYNC_V2_KEYS.server_expiry)),
    rollout_pct: parse_pct(m.get(SYNC_V2_KEYS.rollout_pct)),
    ack_fallback: flag_on(m.get(SYNC_V2_KEYS.ack_fallback)),
    net_telemetry: flag_on(m.get(SYNC_V2_KEYS.net_telemetry)),
    chunked_upload: flag_on(m.get(SYNC_V2_KEYS.chunked_upload)),
    inline_thumbs: flag_on(m.get(SYNC_V2_KEYS.inline_thumbs)),
    markers: {
      schema: marker_on(m.get(SYNC_V2_KEYS.schema)),
      triggers: marker_on(m.get(SYNC_V2_KEYS.triggers)),
      backfill: marker_on(m.get(SYNC_V2_KEYS.backfill)),
      indexes_post: marker_on(m.get(SYNC_V2_KEYS.indexes_post)),
      dualwrite: marker_on(m.get(SYNC_V2_KEYS.dualwrite)),
      code_deployed: marker_on(m.get(SYNC_V2_KEYS.code_deployed)),
      net_beacons: marker_on(m.get(SYNC_V2_KEYS.net_beacons)),
      media_uploads: marker_on(m.get(SYNC_V2_KEYS.media_uploads)),
    },
    loaded: true,
  };
};

// ── Derived switches (one place, so every call site agrees) ─────────────────

// Receipts are written to the PG watermarks alongside the legacy paths.
export const dualwrite_active = (f: SyncV2Flags): boolean => f.mode !== "off";

// Derived values are computed and compared, never served (R1a).
export const shadow_active = (f: SyncV2Flags): boolean => f.mode !== "off";

// The unread comparison runs only once the post-backfill indexes exist:
// without idx_messages_unread each count would walk the chat's whole history.
export const unread_shadow_ready = (f: SyncV2Flags): boolean =>
  shadow_active(f) && f.markers.backfill && f.markers.indexes_post;

// R1b's served behaviour (derived unread, seq-CAS meta, additive frame and
// payload fields, receipt windows, chat:wm, the serial vital chain, poll
// sent_ack, forward ids). Mode 'on' only: 'off' and 'shadow' keep every
// payload byte-identical to the pre-sync-v2 build.
export const v2_on = (f: SyncV2Flags): boolean => f.mode === "on";

// The derived state (seq floors, chat_receipt_mins, idx_messages_unread) is
// complete and indexed: mode 'on' AND the backfill + post-backfill index
// markers. Before both, seq is NULL on old rows and a derived count would
// walk a chat without its index, so the legacy (Redis) values keep serving.
export const derived_ready = (f: SyncV2Flags): boolean =>
  v2_on(f) && f.markers.backfill && f.markers.indexes_post;

export const server_expiry_active = (f: SyncV2Flags): boolean =>
  f.server_expiry || f.mode === "on";

// The clock functions (amigo_alloc_settled …) exist. Set by 20261020c after
// the functions are created, so "on" ⇒ they exist. A stale "off" is safe:
// callers then take the legacy statement and the row triggers allocate.
export const clock_installed = (f: SyncV2Flags): boolean => f.markers.triggers;

// §3.13 pending suppression: only in 'on' with the proto lease honoured. The
// per-user part (gate open: markers + rollout bucket, and a live lease) is
// decided in services/sync/pending-suppress.ts.
export const pending_suppression_active = (f: SyncV2Flags): boolean => v2_on(f) && f.proto_lease;

// §14.14: beacons are accepted only with telemetry on AND the table there.
export const net_beacon_active = (f: SyncV2Flags): boolean => f.net_telemetry && f.markers.net_beacons;

// §14.11: the chunked upload endpoints answer only with the flag on AND the
// media_uploads table there (20261024). Independent of the sync v2 mode: the
// M track ships on its own switch. The daily GC keys on the marker alone, so
// switching the flag off still cleans up uploads left open.
export const chunked_upload_active = (f: SyncV2Flags): boolean => f.chunked_upload && f.markers.media_uploads;

// ── Capability lease (proto-lease.ts) ───────────────────────────────────────
export const PROTO_V2 = "2";

/** What a WS connect's ?proto means for the proto:{uid} lease (§3.13). */
export const lease_action_for_connect = (proto: string | null | undefined): "set" | "clear" =>
  (proto ?? "").trim() === PROTO_V2 ? "set" : "clear";
