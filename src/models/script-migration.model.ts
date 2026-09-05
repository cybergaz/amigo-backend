import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { InferInsertModel, InferSelectModel } from "drizzle-orm";

// The one-off script ledger: which of scripts/migrations/* has been applied to
// THIS database. Written by scripts/lib/migration.ts, read by
// `bun run script:migrate status`.
//
// It is declared here for one reason only: drizzle-kit push diffs the live DB
// against this schema and offers to DROP anything it doesn't recognise. Without
// this file a routine `bun run db:push` would propose dropping the ledger, and
// every environment would silently forget what it had run. Nothing in src/ reads
// this table — the runner owns it, and creates it itself with CREATE TABLE IF NOT
// EXISTS, so keep the shape below in step with the DDL there.
const script_migration_model = pgTable("script_migrations", {
  name: text().primaryKey(), // filename minus .ts, e.g. "20260831-otp-hardening"
  checksum: text().notNull(), // sha256 prefix — flags a script edited after it ran
  applied_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
  applied_by: text(), // "user@host" of whoever ran it
});

type ScriptMigrationType = InferSelectModel<typeof script_migration_model>;
type InsertScriptMigrationType = InferInsertModel<typeof script_migration_model>;

export { script_migration_model };
export type { ScriptMigrationType, InsertScriptMigrationType };
