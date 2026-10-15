// =============================================================================
// Thumbnail + poster passthrough on message attachments (SYNC_V2 §14.7 item 5)
// =============================================================================
// Attachments have always been opaque JSON to the server (jsonb, t.Any()):
// whatever the sender put in `attachments[i]` is stored and relayed. The M
// track adds two client-made fields that new apps render first:
//   thumb      inline base64 JPEG (64 px, q50, ~2 KB) — paints before any
//              download; images and video
//   thumb_url  https URL of a video poster (320 px, q60) — from
//              POST /api/media/upload/:id/complete (or any uploaded image)
// Old apps ignore unknown keys, so this is additive. The server only BOUNDS
// them, because they ride every copy of the message (WS frames, history,
// chat list, sync rows): an invalid or oversized value is DROPPED from
// that attachment — never the message (an old/new app mismatch must not
// lose a send). Everything else in an attachment is untouched, as before.
// `thumb` is kept only while app_settings.sync_v2_inline_thumbs is on (off
// by default, and the kill switch if thumb bytes ever weigh on Redis / PG).
//
// Copies that never carry `thumb` (the app gets it from the stored row:
// history / sync):
//   - FCM: a push is a 4 KB doorbell; stripping keeps a media message
//     fitting instead of degrading to the `partial` stub (fcm-batch.service.ts)
//   - the per-recipient pending store (polling.cache.ts): one copy per
//     recipient in Redis (noeviction) and missed_ws_messages (PG, 30 days) —
//     a 500-member group would multiply every thumb by 500
//   - the per-chat chat_meta hash (chat-meta.cache.ts): a list preview
// `thumb_url` is short and stays everywhere.
// =============================================================================

// base64 of a 64 px q50 JPEG is ~1.5–2.5 KB; 4096 chars ≈ 3 KB decoded.
export const MAX_INLINE_THUMB_CHARS = 4096;
// An album message: at most this many thumb characters in one message; the
// first attachments keep theirs, later ones lose it.
// 8 KB ≈ four typical thumbs: live frames carry the message's thumbs plus
// its replied-to preview's, so one frame stays ≤ ~16 KB of thumbs.
export const MAX_INLINE_THUMBS_TOTAL_CHARS = 8_192;
export const MAX_THUMB_URL_CHARS = 1024;

// Raw base64 (no data: prefix) of a JPEG: base64 of FF D8 FF starts "/9j/".
const THUMB_RE = /^\/9j\/[A-Za-z0-9+/]*={0,2}$/;
const URL_RE = /^https:\/\/[^\s"'<>\\]+$/;

// The app sends ONE attachment as a plain object (ChatMessagePayload.attachments
// is a map); albums / other clients may send a list. Both shapes are bounded:
// an object is handled as a one-element list and unwrapped again, so the
// shape on the wire never changes.
const is_record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

const on_list = <T>(attachments: T, fn: (list: unknown[]) => unknown[]): T => {
  if (Array.isArray(attachments)) return fn(attachments) as T;
  if (!is_record(attachments)) return attachments;
  const out = fn([attachments]);
  return (out[0] === attachments ? attachments : out[0]) as T;
};

export const valid_inline_thumb = (v: unknown): v is string =>
  typeof v === "string" && v.length <= MAX_INLINE_THUMB_CHARS && v.length % 4 === 0 && THUMB_RE.test(v);

export const valid_thumb_url = (v: unknown): v is string =>
  typeof v === "string" && v.length <= MAX_THUMB_URL_CHARS && URL_RE.test(v);

/**
 * Bound `thumb` / `thumb_url` on each attachment. Returns the SAME value
 * (identity) when nothing needs changing — every message from an old app —
 * so legacy payloads stay byte-identical; otherwise a copy with the bad
 * fields removed. A single attachment object is bounded the same way;
 * any other input is returned as is.
 * `inline_thumbs` false (the flag off) drops every non-null `thumb`.
 */
export const sanitize_attachments = <T>(attachments: T, opts: { inline_thumbs: boolean }): T =>
  on_list(attachments, (list) => sanitize_list(list, opts));

const sanitize_list = (attachments: unknown[], opts: { inline_thumbs: boolean }): unknown[] => {
  let out: unknown[] | null = null;
  let total = 0;
  attachments.forEach((a, i) => {
    if (!a || typeof a !== "object" || Array.isArray(a)) return;
    const rec = a as Record<string, unknown>;
    const has_thumb = "thumb" in rec;
    const has_url = "thumb_url" in rec;
    if (!has_thumb && !has_url) return;
    let drop_thumb = false;
    let drop_url = false;
    if (has_thumb) {
      if (rec.thumb === null) {
        // explicit null: harmless, keep as sent
      } else if (!opts.inline_thumbs || !valid_inline_thumb(rec.thumb)
        || total + (rec.thumb as string).length > MAX_INLINE_THUMBS_TOTAL_CHARS) {
        drop_thumb = true;
      } else {
        total += (rec.thumb as string).length;
      }
    }
    if (has_url && rec.thumb_url !== null && !valid_thumb_url(rec.thumb_url)) drop_url = true;
    if (!drop_thumb && !drop_url) return;
    const copy: Record<string, unknown> = { ...rec };
    if (drop_thumb) delete copy.thumb;
    if (drop_url) delete copy.thumb_url;
    out ??= [...attachments];
    out[i] = copy;
  });
  return out ?? attachments;
};

/** `thumb` removed from every attachment; identity when there is none. */
export const strip_list = (attachments: unknown): unknown => on_list(attachments, strip_array);

const strip_array = (attachments: unknown[]): unknown[] => {
  if (!attachments.some((a) => a && typeof a === "object" && "thumb" in (a as object))) return attachments;
  return attachments.map((a) => {
    if (!a || typeof a !== "object" || !("thumb" in (a as object))) return a;
    const { thumb: _t, ...rest } = a as Record<string, unknown>;
    return rest;
  });
};

/**
 * FCM projection / pending store: drop inline `thumb` from a frame payload's
 * attachments and its replied-to preview's attachments. Identity when there
 * is none.
 */
export const strip_inline_thumbs = <P extends Record<string, any>>(p: P): P => {
  const att = strip_list(p.attachments);
  const rtm = p.replied_to_message;
  const rtm_att = rtm && typeof rtm === "object" ? strip_list(rtm.attachments) : undefined;
  const rtm_changed = rtm && typeof rtm === "object" && rtm_att !== rtm.attachments;
  if (att === p.attachments && !rtm_changed) return p;
  const out: Record<string, any> = { ...p };
  if (att !== p.attachments) out.attachments = att;
  if (rtm_changed) out.replied_to_message = { ...rtm, attachments: rtm_att };
  return out as P;
};

/** strip_inline_thumbs on a WS message's payload; the same object when nothing changes. */
export const strip_ws_thumbs = <M extends { payload?: unknown }>(m: M): M => {
  const p = m.payload;
  if (!p || typeof p !== "object" || Array.isArray(p)) return m;
  const s = strip_inline_thumbs(p as Record<string, any>);
  return s === p ? m : { ...m, payload: s };
};
