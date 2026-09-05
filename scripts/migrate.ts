#!/usr/bin/env bun
/**
 * One-off script runner — the only thing you need to know about `apply-*` scripts.
 *
 *   bun run scripts/migrate.ts status          what this DB has run, and what it hasn't
 *   bun run scripts/migrate.ts up              run everything pending, oldest first
 *   bun run scripts/migrate.ts up <name>       run one
 *   bun run scripts/migrate.ts mark <name>     record as applied WITHOUT running it
 *   bun run scripts/migrate.ts mark --all      record every migration on disk as applied
 *   bun run scripts/migrate.ts unmark <name>   remove from the ledger (so it goes pending)
 *
 * Flags: --force (re-run something already applied)  --yes (skip the remote-DB prompt)
 *
 * The answer to "which one did I just run / which one still needs prod" is always
 * `status`, run in the environment you are asking about. Nothing is ever moved on
 * disk, so git only ever sees new files — no renames, no conflicts.
 */
import { join } from "node:path";
import {
  MIGRATIONS_DIR, REPO_ROOT, connect, forget, ledger, markApplied,
  nameOf, onDisk, checksumOf, target,
} from "./lib/migration";

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const args = argv.filter((a) => !a.startsWith("--"));
const cmd = args[0] ?? "status";

const t = target();

/** Resolve a user-typed name to a file on disk; tolerates a partial match. */
function resolveName(input: string): string {
  const files = onDisk();
  const exact = files.find((f) => nameOf(f) === input || f === input);
  if (exact) return exact;
  const hits = files.filter((f) => f.includes(input));
  if (hits.length === 1) return hits[0]!;
  if (hits.length === 0) throw new Error(`No migration matches "${input}".`);
  throw new Error(`"${input}" is ambiguous:\n  ${hits.join("\n  ")}`);
}

function banner() {
  console.log(`\n  target: ${t.label}  [${t.env}]\n`);
}

/** Anything that writes to a non-dev DB asks first. --yes bypasses it. */
async function confirmRemote(what: string) {
  if (t.isDev || flags.has("--yes")) return;
  const answer = prompt(`  ⚠️  ${what} against PROD db "${t.label}". Type the db name to continue:`);
  if (answer !== t.database) {
    console.log("  aborted.");
    process.exit(1);
  }
}

async function status() {
  banner();
  const sql = connect();
  const rows = await ledger(sql);
  await sql.end();

  const files = onDisk();
  if (files.length === 0) {
    console.log("  (no migrations in scripts/migrations/)\n");
    return { pending: [] as string[] };
  }

  const width = Math.max(...files.map((f) => nameOf(f).length));
  const pending: string[] = [];

  for (const file of files) {
    const name = nameOf(file);
    const row = rows.get(name);
    if (!row) {
      pending.push(file);
      console.log(`  ○ ${name.padEnd(width)}   PENDING`);
      continue;
    }
    const when = new Date(row.applied_at).toISOString().slice(0, 10);
    const drift = row.checksum !== checksumOf(join(MIGRATIONS_DIR, file))
      ? "  ⚠️ file changed since it ran"
      : "";
    console.log(`  ● ${name.padEnd(width)}   applied ${when}${drift}`);
  }

  const orphans = [...rows.keys()].filter((n) => !files.some((f) => nameOf(f) === n));
  for (const o of orphans) console.log(`  ? ${o.padEnd(width)}   in ledger, no file on disk`);

  console.log(
    `\n  ${files.length - pending.length} applied, ${pending.length} pending` +
    (pending.length ? `  →  bun run scripts/migrate.ts up\n` : `  →  nothing to do\n`),
  );
  return { pending };
}

async function runOne(file: string): Promise<boolean> {
  const path = join(MIGRATIONS_DIR, file);
  console.log(`\n──── ${nameOf(file)} ────`);
  const proc = Bun.spawn(["bun", "run", path, ...(flags.has("--force") ? ["--force"] : [])], {
    cwd: REPO_ROOT,
    stdio: ["inherit", "inherit", "inherit"],
    env: process.env,
  });
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`\n  ✖ ${nameOf(file)} exited ${code}. Stopping — nothing after it was run.\n`);
    return false;
  }
  const sql = connect();
  await ledger(sql);
  await markApplied(sql, path);
  await sql.end();
  console.log(`  ✔ ${nameOf(file)} applied and recorded.`);
  return true;
}

async function up() {
  const one = args[1];
  let queue: string[];

  if (one) {
    const file = resolveName(one);
    const sql = connect();
    const rows = await ledger(sql);
    await sql.end();
    if (rows.has(nameOf(file)) && !flags.has("--force")) {
      banner();
      console.log(`  ${nameOf(file)} is already applied here. Pass --force to run it again.\n`);
      return;
    }
    queue = [file];
    banner();
  } else {
    const { pending } = await status();
    if (pending.length === 0) return;
    queue = pending;
  }

  await confirmRemote(`about to run ${queue.length} migration(s)`);
  for (const file of queue) if (!(await runOne(file))) process.exit(1);
  console.log(`\n  done — ${queue.length} applied on ${t.label}\n`);
}

async function mark() {
  const files = flags.has("--all") ? onDisk() : [resolveName(args[1] ?? "")];
  banner();
  await confirmRemote(`about to mark ${files.length} migration(s) as applied WITHOUT running them`);
  const sql = connect();
  await ledger(sql);
  for (const f of files) {
    await markApplied(sql, join(MIGRATIONS_DIR, f));
    console.log(`  ● ${nameOf(f)} recorded as applied (not run)`);
  }
  await sql.end();
  console.log();
}

async function unmark() {
  const name = nameOf(args[1] ?? "");
  banner();
  await confirmRemote(`about to remove "${name}" from the ledger`);
  const sql = connect();
  await ledger(sql);
  await forget(sql, name);
  await sql.end();
  console.log(`  ○ ${name} removed from the ledger — it will show as PENDING again.\n`);
}

try {
  switch (cmd) {
    case "status": await status(); break;
    case "up": await up(); break;
    case "mark": await mark(); break;
    case "unmark": await unmark(); break;
    default:
      console.log(`Unknown command "${cmd}". Try: status | up | mark | unmark`);
      process.exit(1);
  }
} catch (e) {
  console.error(`\n  ✖ ${(e as Error).message}\n`);
  process.exit(1);
}
process.exit(0);
