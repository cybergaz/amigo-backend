// =============================================================================
// Per-socket serial vital frames (SYNC_V2_PROTOCOL.md §3.3.5, §5.12; R1b)
// =============================================================================
// Bun dispatches a socket's frames without waiting for the previous handler,
// so two vital frames from one client could commit out of order ("send then
// pin" pinned a message that was not stored yet; a read receipt could commit
// before the send it covers). With sync_v2 'on', socket.server runs a
// socket's VITAL frames one after another — but only through
// validate → commit → ack:
//
//   per-socket chain     store_message + message:sent:ack, set_pin,
//                        apply_receipts, delete, forward inserts
//   per-(sender, chat)   the fan-out of each, DETACHED: the next frame's
//                        commit does not wait for an O(N) group fan-out, so
//                        the sent-ack latency fix (ack before fan-out) holds
//
// Handlers mark their fan-out with run_fanout(sender, chat, fn). Outside a
// vital context (sync_v2 off / shadow, HTTP poll sends, internal callers) it
// simply awaits fn — exactly the pre-R1b behaviour. Inside, fn is chained per
// (sender, chat), so one sender's fan-outs into one chat keep commit order,
// and the chain is tracked so a drain waits for it (§13.7 B6).
//
// Process-local by design: a socket lives on one worker. Split parts and
// cross-transport ordering are the client's job (§5.12 dependsOnMsgId).
// =============================================================================
import { AsyncLocalStorage } from "node:async_hooks";
import { track } from "@/cluster/lifecycle";
import { count } from "@/utils/counters";

type VitalCtx = { readonly chain: true };

const als = new AsyncLocalStorage<VitalCtx>();
const fanout_tails = new Map<string, Promise<void>>();

// Frames that go through the per-socket chain. Everything else (typing,
// presence, calls, pings) keeps running concurrently.
export const SERIAL_VITAL_TYPES: ReadonlySet<string> = new Set([
  "message:new",
  "message:pin",
  "message:delete",
  "message:forward",
  "conversation:join",
  "conversation:mark_read",
  "message:status:ack",
]);

/** Run `fn` as a serial vital frame: run_fanout calls inside it detach. */
export const in_vital_context = <T>(fn: () => Promise<T>): Promise<T> => als.run({ chain: true }, fn);

/** Whether the caller runs inside a serial vital frame. */
export const in_vital_chain = (): boolean => als.getStore() !== undefined;

/**
 * The fan-out of a committed vital event. Awaited inline outside a vital
 * context; detached onto the (sender, chat) chain inside one. Never rejects
 * when detached (a failure is logged and counted: the event is committed,
 * and heads / delta / the pending store repair a missed frame).
 */
export const run_fanout = async (sender_id: string, chat_id: string, fn: () => Promise<void>): Promise<void> => {
  if (!in_vital_chain()) return fn();
  const key = `${sender_id}|${chat_id}`;
  const prev = fanout_tails.get(key) ?? Promise.resolve();
  // als.exit: nested run_fanout calls inside fn run inline, on this link.
  const next = prev.then(() => als.exit(fn)).catch((err: any) => {
    count("WS", "fanout_failed");
    console.error(`[WS] detached fan-out failed (sender=${sender_id} chat=${chat_id}): ${err?.message ?? err}`);
  });
  fanout_tails.set(key, next);
  track(next);
  void next.then(() => {
    if (fanout_tails.get(key) === next) fanout_tails.delete(key);
  });
  count("WS", "fanout_detached");
};

/**
 * Chain one frame behind the socket's previous vital frame. `holder` is the
 * socket's ws.data; the tail never rejects, so one failed frame does not
 * stall the ones behind it.
 */
export const chain_vital = <T>(holder: { vital_tail?: Promise<unknown> }, fn: () => Promise<T>): Promise<T> => {
  const prev = holder.vital_tail ?? Promise.resolve();
  const run = prev.then(() => in_vital_context(fn));
  holder.vital_tail = run.then(() => undefined, () => undefined);
  return run;
};

export const vital_chain_stats = () => ({ fanout_chains: fanout_tails.size });
