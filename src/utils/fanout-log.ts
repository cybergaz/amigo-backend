// =============================================================================
// [FANOUT] — one log line per delivered message (SYNC_V2 RC-1 logs)
// =============================================================================
// For the next "missing messages on one phone" report: which bucket each
// recipient was in when the message went out, and whether its FCM pushes
// were accepted. One line per MESSAGE (never per recipient), so the volume is
// the message rate, not the fan-out size:
//
//   [FANOUT] kind=new msg=<id> chat=<id> rcpt=12 on=3 bg=1 poll=2 off=6 fcm=7 sent=6 failed=1
//
// on = live WS (bg is the subset of on/poll that also gets FCM), poll = fresh
// polling lease, off = neither. fcm = pushes queued; sent/failed come from the
// batched FCM send (fcm-batch.service, up to 4 s later), so the line is
// printed when the last result is in, or after FCM_RESULT_WAIT_MS with
// `pending=<n>` (a lost batch, e.g. a hard exit). failed includes "no token".
// Which recipient was where is debug detail: AMIGO_DEBUG=FANOUT prints the
// ids on a second line.

import { debug_log } from "./debug-log";

const FCM_RESULT_WAIT_MS = 20_000;

type FanoutBuckets = {
  online: string[];
  offline: string[];
  polling: string[];
  background: string[];
};

type FanoutFields = {
  kind: string;
  message_id: string;
  chat_id: string;
  recipients: number;
  online: number;
  background: number;
  polling: number;
  offline: number;
  fcm: number;
  sent: number;
  failed: number;
  pending: number;
};

const format_fanout_line = (f: FanoutFields): string =>
  `[FANOUT] kind=${f.kind} msg=${f.message_id} chat=${f.chat_id} rcpt=${f.recipients} ` +
  `on=${f.online} bg=${f.background} poll=${f.polling} off=${f.offline} ` +
  `fcm=${f.fcm} sent=${f.sent} failed=${f.failed}` +
  (f.pending > 0 ? ` pending=${f.pending}` : "");

type FanoutTracker = {
  // Call once per push about to be queued; pass the returned callback to
  // queue_message_fcm({ on_result }). Extra calls of one callback are ignored.
  fcm_queued: () => (ok: boolean) => void;
  // Call after the last push is queued; with no pushes it prints at once.
  done_queueing: () => void;
};

// `exclude` drops ids from the counts (the forwarder, who is in the buckets
// because forwards do not exclude it from the broadcast).
const start_fanout_log = (
  kind: string,
  message_id: string,
  chat_id: string,
  buckets: FanoutBuckets,
  opts: {
    exclude?: string;
    log?: (line: string) => void;
    wait_ms?: number;
  } = {},
): FanoutTracker => {
  const log = opts.log ?? ((line: string) => console.log(line));
  const keep = (ids: string[]) => (opts.exclude ? ids.filter((id) => id !== opts.exclude) : ids);
  const online = keep(buckets.online);
  const offline = keep(buckets.offline);
  const polling = keep(buckets.polling);
  const background = keep(buckets.background);

  let queued = 0;
  let sent = 0;
  let failed = 0;
  let queueing = true;
  let printed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const print = () => {
    if (printed) return;
    printed = true;
    if (timer) clearTimeout(timer);
    log(format_fanout_line({
      kind,
      message_id,
      chat_id,
      recipients: online.length + polling.length + offline.length,
      online: online.length,
      background: background.length,
      polling: polling.length,
      offline: offline.length,
      fcm: queued,
      sent,
      failed,
      pending: queued - sent - failed,
    }));
  };
  const maybe_print = () => {
    if (!queueing && sent + failed >= queued) print();
  };

  debug_log("FANOUT", () =>
    `ids msg=${message_id} on=${online.join(",")} bg=${background.join(",")} ` +
    `poll=${polling.join(",")} off=${offline.join(",")}`,
  );

  return {
    fcm_queued: () => {
      queued++;
      let reported = false;
      return (ok: boolean) => {
        if (reported || printed) return;
        reported = true;
        if (ok) sent++;
        else failed++;
        maybe_print();
      };
    },
    done_queueing: () => {
      queueing = false;
      maybe_print();
      if (!printed && !timer) {
        timer = setTimeout(print, opts.wait_ms ?? FCM_RESULT_WAIT_MS);
        // Never keep a draining process alive just to print a log line.
        (timer as { unref?: () => void }).unref?.();
      }
    },
  };
};

export { FCM_RESULT_WAIT_MS, format_fanout_line, start_fanout_log };
export type { FanoutBuckets, FanoutFields, FanoutTracker };
