import type { Lease } from "@/cluster/lease-core";

// =============================================================================
// FCM broadcast-to-all waves under a fenced lease (SYNC_V2 §13.7 D3/F12)
// =============================================================================
// broadcast_to_all (the "update available" push to every user) used to load
// every token into memory and send in waves from whichever process ran it.
// Two runs at once (the version script run twice, or run on two boxes)
// pushed everyone twice; a run killed half-way (deploy, Ctrl-C, OOM) left the
// rest unsent, and re-running it pushed the first half again.
//
// Now:
//   - redis_lease('fcm_broadcast'): one run at a time across every process;
//     a second run returns at once with `skipped: 'busy'`;
//   - keyset pages by user id, and after every wave a FENCED cursor write
//     {run_id, after_id, counts}: only the current lease holder can advance
//     it, and a holder that lost its lease stops at its next wave;
//   - a run with the same run_id (default: a hash of the notification) that
//     finds an unfinished cursor RESUMES after it instead of starting over;
//     a finished run clears the cursor, so sending the same notice again
//     later is a fresh run.
// Pure (deps injected) so the wave/lease logic is tested against a real
// redis-server; fcm.service binds it to Postgres + firebase-admin.

type WaveRow = { id: string; fcm_token: string };

type WaveDeps = {
  acquire: () => Promise<Lease | null>;
  // Users with a token and id > after (null = from the start), ordered by id.
  fetch_page: (after: string | null, limit: number) => Promise<WaveRow[]>;
  send: (row: WaveRow) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
};

type WaveOptions = {
  run_id: string;
  concurrency: number;
  delay_ms: number;
  page_size?: number;
  cursor_ttl_s?: number;
};

type WaveResult = {
  recipients: number;
  sent: number;
  failed: number;
  waves: number;
  skipped?: "busy";
  resumed?: boolean;
  aborted?: "lease_lost";
};

type Cursor = { run_id: string; after_id: string | null; recipients: number; sent: number; failed: number; waves: number };

const parse_cursor = (raw: string | null): Cursor | null => {
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as Cursor;
    return typeof c?.run_id === "string" ? c : null;
  } catch {
    return null;
  }
};

const run_leased_waves = async (deps: WaveDeps, opts: WaveOptions): Promise<WaveResult> => {
  const log = deps.log ?? ((m: string) => console.log(m));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const page_size = Math.max(opts.page_size ?? 1000, opts.concurrency);
  const cursor_ttl_s = opts.cursor_ttl_s ?? 24 * 60 * 60;

  const lease = await deps.acquire();
  if (!lease) {
    log(`[FCM] broadcast skipped: another run holds the fcm_broadcast lease`);
    return { recipients: 0, sent: 0, failed: 0, waves: 0, skipped: "busy" };
  }
  try {
    const prev = parse_cursor(await lease.get_cursor());
    const resumed = prev?.run_id === opts.run_id;
    const c: Cursor = resumed
      ? { ...prev! }
      : { run_id: opts.run_id, after_id: null, recipients: 0, sent: 0, failed: 0, waves: 0 };
    if (resumed) log(`[FCM] broadcast resuming run ${opts.run_id} after ${c.after_id} (sent=${c.sent} failed=${c.failed})`);
    else if (prev) log(`[FCM] broadcast: discarding unfinished cursor of run ${prev.run_id}`);

    while (true) {
      const page = await deps.fetch_page(c.after_id, page_size);
      if (page.length === 0) break;
      for (let i = 0; i < page.length; i += opts.concurrency) {
        const slice = page.slice(i, i + opts.concurrency);
        const results = await Promise.allSettled(slice.map((row) => deps.send(row)));
        for (const r of results) {
          if (r.status === "fulfilled" && r.value === true) c.sent++;
          else c.failed++;
        }
        c.recipients += slice.length;
        c.waves++;
        c.after_id = slice[slice.length - 1]!.id;
        // Fenced progress + lease renewal in one: false means another run
        // took over (our lease expired) — stop, it continues from ITS cursor.
        if (!(await lease.set_cursor(JSON.stringify(c), cursor_ttl_s)) || !(await lease.renew())) {
          log(`[FCM] broadcast run ${opts.run_id} lost its lease after ${c.waves} waves; stopping`);
          return { recipients: c.recipients, sent: c.sent, failed: c.failed, waves: c.waves, resumed, aborted: "lease_lost" };
        }
        const more = i + opts.concurrency < page.length || page.length === page_size;
        if (opts.delay_ms > 0 && more) await sleep(opts.delay_ms);
      }
      if (page.length < page_size) break;
    }
    await lease.clear_cursor();
    return { recipients: c.recipients, sent: c.sent, failed: c.failed, waves: c.waves, ...(resumed ? { resumed } : {}) };
  } finally {
    await lease.release();
  }
};

export { run_leased_waves };
export type { WaveDeps, WaveOptions, WaveResult, WaveRow };
