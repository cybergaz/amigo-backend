// Pure part of [UNREAD-SHADOW] (unread-shadow.ts), kept import-free of the
// DB pool so tests can load it.
import { UNREAD_CAP } from "./seq-queries";

export type ServedUnread = { chat_id: string; unread: number };
export type UnreadMismatch = { chat_id: string; derived: number; served: number };

/** Pure comparison: served counts are capped like derived ones (old clients see ≤ 100). */
export const compare_unread = (
  served: ServedUnread[],
  derived: { chat_id: string; unread: number; numbered: boolean }[],
): { checked: number; mismatches: UnreadMismatch[] } => {
  const d = new Map(derived.map((r) => [r.chat_id.toLowerCase(), r]));
  const mismatches: UnreadMismatch[] = [];
  let checked = 0;
  for (const s of served) {
    const row = d.get(s.chat_id.toLowerCase());
    if (!row || !row.numbered) continue;
    checked++;
    const served_capped = Math.min(Math.max(0, s.unread | 0), UNREAD_CAP);
    if (served_capped !== row.unread) mismatches.push({ chat_id: s.chat_id, derived: row.unread, served: served_capped });
  }
  return { checked, mismatches };
};

