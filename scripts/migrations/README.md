# One-off DB scripts

Every `apply-*`-style script lives here, named `YYYYMMDD-slug.ts`, and **never moves
again**. Whether a script has run is recorded in the target database, not in the
folder it sits in.

## Why it works this way

The old scheme moved a script `scripts/` → `applied-dev/` → `applied-archive/` as it
was run. That could not work: the filesystem is exactly what git syncs from dev to
prod, so one tree had to mean "already applied" and "still pending" at the same time.
After a push, prod saw a folder full of `applied-dev/` scripts with no way to tell the
new ones from the ones it had already run — and each self-move was a tracked rename
that conflicted on the next pull.

Applied-vs-pending is **per environment**, so it belongs in the thing that is per
environment: the database. Each DB carries its own ledger table:

```sql
script_migrations (name, checksum, applied_at, applied_by)
```

Dev's DB and prod's DB each keep their own. The same commit checked out in both places
reports two different pending lists. Git only ever sees new files — no renames, no
conflicts, nothing to resolve.

## Daily use

Run these on the machine whose DB you're targeting — dev locally, prod on the prod box
after a `git pull`. `DB_URL` in that box's `.env` decides the target, and the runner
prints it before doing anything.

```bash
bun run script:migrate status         # what this DB has run, and what it still owes
bun run script:migrate up             # run everything pending, oldest first
bun run script:migrate up otp-hard    # run one (partial name is fine)
```

Typical cycle:

```
laptop     bun run script:migrate status   →  1 pending
           bun run script:migrate up       →  applied on dev
           git add . && git commit && git push

prod box   git pull
           bun run script:migrate status   →  1 pending   ← same commit, different answer
           bun run script:migrate up       →  applied on prod
           bun run script:migrate status   →  nothing to do
```

`up` against a non-local `DB_URL` makes you type the database name first. `--yes`
skips that for scripted deploys.

## Escape hatches

```bash
bun run script:migrate mark <name>      # record as applied WITHOUT running it
bun run script:migrate mark --all       # baseline: everything on disk is already applied here
bun run script:migrate unmark <name>    # drop from the ledger → shows PENDING again
bun run script:migrate up <name> --force  # run it again even though it's applied
```

`mark` is how you tell a database about work that predates the ledger, or that you
applied by hand.

## First run against a database that predates the ledger

A DB with no `script_migrations` table reports **everything** as pending, which is a
lie for any environment that has been running for a while. Tell it the truth once,
before you ever run `up` there:

- Everything on disk has already been applied here → `bun run script:migrate mark --all`
- Only some of it → `bun run script:migrate mark <name>` per applied script, then `up` the rest

Both dev (2026-08-31) and prod (2026-09-05) were baselined this way — all 10 scripts
had already been applied in both. Any *new* environment — a fresh staging DB, say —
starts empty and correctly wants a plain `up`.

## Writing a new one

Name it `YYYYMMDD-what-it-does.ts` (the date prefix is the run order) and end it with:

```ts
import { skipIfApplied, recordApplied } from "../lib/migration";

await skipIfApplied(import.meta.path);   // no-op if this DB already ran it

// ... the work ...

if (succeeded) await recordApplied(import.meta.path);
process.exit(succeeded ? 0 : 1);
```

Keep the SQL idempotent (`IF NOT EXISTS`, guarded `ALTER`) — the ledger is the
bookkeeping, idempotence is the safety net. Paths to `drizzle/*.sql` stay relative to
the repo root; the runner sets the cwd there.

Do **not** add a `package.json` entry per script. There is one entry, `migrate`, and it
covers all of them.
