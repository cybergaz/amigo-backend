// =============================================================================
// Bulk soft deletes, one short statement per chat (SYNC_V2_PROTOCOL.md §3.3.1)
// =============================================================================
// Used by: soft_delete_message (multi-id delete-for-everyone), the broadcast
// copy cascade (soft_delete_broadcast_copies) and the disappearing sweeper.
// Ids are grouped by chat and the chats are visited in id order; each chat is
// one autocommit statement that allocates the whole mod_seq block at once
// (write-queries.bulk_soft_delete_chat). Every statement holds exactly one
// chat row lock, so two bulk deletes — or a bulk delete and a send — can
// never wait on each other in a cycle through chats rows.
//
// Before 20261020c (no clock functions) the same grouping runs the plain
// legacy UPDATE per chat.
// =============================================================================
import { pg_client } from "@/config/db";
import { sync_v2_flags } from "@/services/app-settings.service";
import { clock_installed } from "./flags-core";
import {
  bulk_soft_delete_chat,
  group_by_chat_sorted,
  type BulkDeleteResult,
  type BulkDeleteRow,
} from "./write-queries";
import { count } from "@/utils/counters";
import type postgres from "postgres";

type Sql = postgres.Sql<any> | postgres.TransactionSql<any>;

const code_of = (e: unknown) => (e as { code?: string })?.code ?? "";

/** One chat, retrying a deadlock (40P01) once (§3.3.1). */
export const soft_delete_one_chat = async (
  chat_id: string,
  ids: string[],
  opts: { expired_only?: boolean; sender_id?: string | null; exec?: Sql } = {},
): Promise<BulkDeleteResult> => {
  const run = () =>
    bulk_soft_delete_chat(opts.exec ?? pg_client, chat_id, ids, {
      use_clock: clock_installed(sync_v2_flags()),
      expired_only: opts.expired_only,
      sender_id: opts.sender_id ?? null,
    });
  let res: BulkDeleteResult;
  try {
    res = await run();
  } catch (err) {
    const code = code_of(err);
    if (code === "55P03") count("SEQ", "lock_timeout");
    // Inside a caller's transaction the transaction is already aborted, so a
    // retry there is pointless; the caller's next tick retries instead.
    if (code !== "40P01" || opts.exec) throw err;
    count("SEQ", "deadlock_retry");
    res = await run();
  }
  if (res.burned > 0) count("SEQ", "burn", res.burned);
  return res;
};

/**
 * Many chats: grouped, chats sorted, one statement per chat. A failure on one
 * chat is logged and counted in `failed_chats` while the others still delete
 * — the rows that DID commit must still be fanned out, so the caller gets
 * them either way. The failed chat's rows stay live; a replay of the same
 * delete (client outbox / next sweep) retries them.
 * `rows` = what THIS call deleted (RETURNING decides who broadcasts).
 */
export const soft_delete_grouped = async (
  pairs: { id: string; chat_id: string }[],
  opts: { expired_only?: boolean; sender_id?: string | null; concurrency?: number } = {},
): Promise<{ rows: BulkDeleteRow[]; failed_chats: number }> => {
  const groups = group_by_chat_sorted(pairs);
  const out: BulkDeleteRow[] = [];
  let failed_chats = 0;
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 1, groups.length));
  let next = 0;
  const lane = async () => {
    while (next < groups.length) {
      const [chat_id, ids] = groups[next++]!;
      try {
        const res = await soft_delete_one_chat(chat_id, ids, opts);
        out.push(...res.rows);
      } catch (err: any) {
        failed_chats++;
        console.error(`[DELETE] chat ${chat_id} (${ids.length} ids) failed: ${err?.code ?? ""} ${err?.message ?? err}`);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, lane));
  return { rows: out, failed_chats };
};
