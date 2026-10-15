// =============================================================================
// Additive Sync v2 frame / payload fields (SYNC_V2_PROTOCOL.md §4.1)
// =============================================================================
// Every helper here is used ONLY when sync_v2 = 'on' (flags-core v2_on):
// with 'off' / 'shadow' no frame gains a key, so 4.2.2 and App H see the
// exact pre-sync-v2 payloads. Old apps ignore unknown keys in 'on' too
// (additive only; nothing existing changes type or meaning).
//
// Pure: no db / redis imports.
// =============================================================================

type StoredRow = {
  seq?: number | string | null;
  mod_seq?: number | string | null;
  created_at?: Date | string | null;
} | null | undefined;

const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

const iso = (v: Date | string | null | undefined): string | null =>
  v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString();

/** message:new payload fields: {seq, mod_seq, srv_ts} of the stored row. */
export const msg_seq_fields = (row: StoredRow): { seq: number | null; mod_seq: number | null; srv_ts: string | null } => ({
  seq: n(row?.seq),
  mod_seq: n(row?.mod_seq),
  srv_ts: iso(row?.created_at ?? null),
});

/** message:sent:ack fields: {seq, srv_ts} (a duplicate passes the ORIGINAL row). */
export const ack_seq_fields = (row: StoredRow): { seq: number | null; srv_ts: string | null } => ({
  seq: n(row?.seq),
  srv_ts: iso(row?.created_at ?? null),
});

/**
 * message:delete `pin` (§3.12 delete-unpin): included when the chat is now
 * unpinned and its pin_seq was allocated at or after the first mod_seq of
 * this delete, i.e. the delete's trigger cleared the pin. It is an absolute
 * state ({pinned_msg_id: null, pin_seq}), so a concurrent unpin that also
 * matches is still the truth; clients apply it by pin_seq CAS.
 */
export const delete_unpin_field = (
  st: { pinned_msg_id: string | null; pin_seq: number | null },
  mods: { mod_seq: number }[],
): { pinned_msg_id: null; pin_seq: number } | undefined => {
  if (st.pinned_msg_id !== null || st.pin_seq === null || mods.length === 0) return undefined;
  const first = Math.min(...mods.map((m) => m.mod_seq));
  return st.pin_seq >= first ? { pinned_msg_id: null, pin_seq: st.pin_seq } : undefined;
};
