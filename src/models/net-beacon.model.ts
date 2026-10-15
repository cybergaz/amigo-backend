import { pgTable, bigserial, jsonb, text, timestamp, uuid, index } from "drizzle-orm/pg-core";
import { InferInsertModel, InferSelectModel } from "drizzle-orm";

// Client network telemetry (SYNC_V2 §14.14): one row per accepted beacon
// (≤ 4 KB JSON, no message content), written in batches by the beacon
// flusher (services/net-beacon.service.ts), kept 14 days (D-N6).
// Created by scripts/migrations/20261023-net-beacons.ts; declared here so
// drizzle-kit sees no drift. No FK to users on purpose: telemetry must never
// block (or be blocked by) a user delete, and the flusher skips nothing for it.
const net_beacon_model = pgTable(
  "net_beacons",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    user_id: uuid().notNull(),
    ts: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // client network, truncated server-side (/24 IPv4, /48 IPv6)
    ip24: text(),
    app_ver: text(),
    payload: jsonb().notNull(),
  },
  (table) => [index("idx_net_beacons_ts").on(table.ts)],
);

type NetBeaconType = InferSelectModel<typeof net_beacon_model>;
type InsertNetBeaconType = InferInsertModel<typeof net_beacon_model>;

export { net_beacon_model };
export type { NetBeaconType, InsertNetBeaconType };
