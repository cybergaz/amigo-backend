// The plain-words [FEATURES] block (flags-core describe_live_features): what a
// human reading the backend log needs to know — is the new sync really live?
// Run: `bun test tests/live-features.test.ts`.
import { describe, expect, test } from "bun:test";
import { DEFAULT_SYNC_V2_FLAGS, describe_live_features, type SyncV2Flags } from "@/services/sync/flags-core";

const markers = { schema: true, triggers: true, backfill: true, indexes_post: true, dualwrite: true, code_deployed: true, net_beacons: true, media_uploads: true };
const flags = (o: Partial<SyncV2Flags> = {}): SyncV2Flags => ({ ...DEFAULT_SYNC_V2_FLAGS, markers, loaded: true, ...o });
const sync_line = (f: SyncV2Flags) => describe_live_features(f).find((l) => l.startsWith("Sync v2:"))!;

describe("live features summary", () => {
  test("defaults: old sync, every extra off", () => {
    const lines = describe_live_features(flags());
    expect(lines[0]).toStartWith("Always live in this build:");
    expect(sync_line(flags())).toContain("OFF: every app uses the old sync");
    expect(lines.filter((l) => /\s{2}sync_v2_/.test(l)).every((l) => l.includes("off  sync_v2_"))).toBe(true);
  });

  test("shadow says apps still use the old sync", () => {
    expect(sync_line(flags({ mode: "shadow" }))).toContain("SHADOW: every app still uses the old sync");
  });

  test("on: rollout 0 vs partial vs 100, and not-ready", () => {
    expect(sync_line(flags({ mode: "on", rollout_pct: 0 }))).toContain("NO 5.0.1 app uses the new sync yet");
    expect(sync_line(flags({ mode: "on", rollout_pct: 25 }))).toContain("ON for 25% of 5.0.1 apps");
    expect(sync_line(flags({ mode: "on", rollout_pct: 25 }))).toContain("the rest stay on the old sync");
    expect(sync_line(flags({ mode: "on", rollout_pct: 100 }))).not.toContain("the rest stay");
    expect(sync_line(flags({ mode: "on", rollout_pct: 100, markers: { ...markers, backfill: false } }))).toContain("NOT READY");
  });

  test("extras report ON only when they really work", () => {
    const f = flags({ mode: "on", rollout_pct: 100, system_rows: true, proto_lease: true, ack_fallback: true, net_telemetry: true, chunked_upload: true, inline_thumbs: true });
    const lines = describe_live_features(f).filter((l) => /\s{2}sync_v2_/.test(l));
    expect(lines).toHaveLength(6);
    expect(lines.every((l) => l.includes("ON   sync_v2_"))).toBe(true);
    const no_tables = describe_live_features({ ...f, markers: { ...markers, net_beacons: false, media_uploads: false } });
    expect(no_tables.find((l) => l.includes("sync_v2_net_telemetry"))).toContain("ledger 20261023 not run");
    expect(no_tables.find((l) => l.includes("sync_v2_chunked_upload"))).toContain("ledger 20261024 not run");
    expect(describe_live_features(flags({ proto_lease: true })).find((l) => l.includes("sync_v2_proto_lease"))).toContain("needs sync v2 ON");
  });
});
