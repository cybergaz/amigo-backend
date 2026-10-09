// Pure replay ordering for a user's pending (missed) WS events — the
// poll/reconnect read path in polling.cache.ts. Kept free of any db / redis
// import so it can be unit-tested without a database.
//
// Entries are ordered by their store time (created_at, epoch ms). That alone
// is not a total order: a conversation:new and the message:new that needs it
// are usually stored in the SAME millisecond (create_dm / revive / the
// broadcast fan-out emit them back to back), and none of the tiers keeps
// insertion order for ties — Redis HGETALL has no defined field order once a
// hash outgrows its listpack encoding, and the DB tier's created_at is the
// deferred-insert time truncated to ms. A tie resolved the wrong way handed a
// reconnecting client a message:new for a chat it did not have yet.
//
// Tie-break: conversation:new first. It is the only event that CREATES the
// recipient's local chat row; every other event about a chat (message:new,
// conversation:action such as the member_added that follows a group add, ...)
// assumes the row exists. Everything else keeps its relative order (the sort
// is stable), so no other pair of events is reordered.

type PendingReplayEntry = {
  created_at: number; // epoch ms
  ws_message: { type: string };
};

const REPLAY_FIRST_EVENT_TYPES: ReadonlySet<string> = new Set(["conversation:new"]);

const replay_rank = (type: string): number => (REPLAY_FIRST_EVENT_TYPES.has(type) ? 0 : 1);

const compare_pending_for_replay = (a: PendingReplayEntry, b: PendingReplayEntry): number =>
  a.created_at - b.created_at || replay_rank(a.ws_message.type) - replay_rank(b.ws_message.type);

/** Sorts in place (and returns) `entries` into replay order. Stable. */
const sort_pending_for_replay = <T extends PendingReplayEntry>(entries: T[]): T[] =>
  entries.sort(compare_pending_for_replay);

export { compare_pending_for_replay, sort_pending_for_replay };
export type { PendingReplayEntry };
