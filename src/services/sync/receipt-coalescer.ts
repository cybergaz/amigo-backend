// =============================================================================
// Delivered-receipt coalescing buffer (SYNC_V2_PROTOCOL.md §3.7 "Write rate")
// =============================================================================
// Legacy clients ack "delivered" once per message (message:status:ack, and
// POST /message/delivered(/batch) from FCM). Written one by one, a busy group
// would turn every message into N chat_members writes on RDS. Per worker,
// per (user, chat), the ids collected in a ~1 s window become ONE
// apply_receipts item (delivered = max seq of those ids), and every user's
// items in the window become one statement.
//
// Losing the buffer (crash) only delays a grey tick until the next delivered
// receipt: delivered is a monotone max, and every later ack covers it.
//
// Pure (no db / redis), so it is unit-tested directly.
// =============================================================================

export type CoalescedItem = { chat_id: string; delivered_ids: string[] };

export class DeliveredCoalescer {
  // user → chat → ids
  private buf = new Map<string, Map<string, Set<string>>>();
  private ids_total = 0;

  constructor(
    // Bound per (user, chat): only the newest seq matters, and ids are
    // client UUIDv7 (time-ordered), so the lexicographically largest are
    // the best candidates to keep.
    private readonly max_ids_per_chat = 200,
    // Bound for the whole buffer; past it the caller should flush early.
    readonly soft_limit = 20_000,
  ) {}

  add(user_id: string, chat_id: string, ids: string[]): void {
    if (ids.length === 0) return;
    let chats = this.buf.get(user_id);
    if (!chats) {
      chats = new Map();
      this.buf.set(user_id, chats);
    }
    let set = chats.get(chat_id);
    if (!set) {
      set = new Set();
      chats.set(chat_id, set);
    }
    for (const id of ids) {
      const before = set.size;
      set.add(id);
      if (set.size > before) this.ids_total++;
    }
    if (set.size > this.max_ids_per_chat) {
      const keep = Array.from(set).sort().slice(-this.max_ids_per_chat);
      this.ids_total -= set.size - keep.length;
      chats.set(chat_id, new Set(keep));
    }
  }

  get size(): number {
    return this.ids_total;
  }

  get users(): number {
    return this.buf.size;
  }

  /** Take everything buffered so far, grouped per user. */
  drain(): Map<string, CoalescedItem[]> {
    const out = new Map<string, CoalescedItem[]>();
    for (const [user_id, chats] of this.buf) {
      out.set(
        user_id,
        Array.from(chats, ([chat_id, ids]) => ({ chat_id, delivered_ids: Array.from(ids) })),
      );
    }
    this.buf = new Map();
    this.ids_total = 0;
    return out;
  }
}
