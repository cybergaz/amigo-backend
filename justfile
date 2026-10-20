# Dev tasks, against either the local Docker stack or whatever .env points at.
#
#   just dev                 local Postgres + Redis containers (default)
#   just target=env dev      DB_URL / REDIS_URL from .env (Neon, Redis Cloud, ...)
#
# target=local puts the container URLs in front of each command. dotenv and
# Bun's .env loading never override variables already in the environment, so
# they win over .env without touching it. target=env adds nothing, and .env
# decides.

target := "local"

compose := "docker compose -f docker-compose.local.yml"
local_env := "DB_URL=postgres://amigo:amigo@127.0.0.1:55432/amigo_test REDIS_URL=redis://127.0.0.1:56379 APP_ENV=dev"
run := if target == "local" { local_env } else if target == "env" { "" } else { error("target must be 'local' or 'env'") }
# Start the containers first when they are the target; a no-op otherwise.
ensure_up := if target == "local" { compose + " up -d --wait" } else { "true" }

# list recipes
default:
    @just --list

# start Postgres + Redis and wait until both are healthy
up:
    {{compose}} up -d --wait

# stop the containers (data is kept)
down:
    {{compose}} down

# stop the containers AND delete their data volumes
nuke:
    {{compose}} down -v

# bun dev (watch mode)
dev:
    {{ensure_up}}
    {{run}} bun run dev

# build an EMPTY database: every table, then all one-off ledger scripts
db_initiate:
    {{ensure_up}}
    # Refuses unless the target has no tables. push --force is only safe on an
    # empty DB — never on a shared one (see drizzle.config.ts).
    {{run}} bun run scripts/fresh-db.ts check
    # Tables, enums and indexes straight from src/models.
    {{run}} bunx drizzle-kit push --force
    # Boot markers the sync v2 scripts wait for (see scripts/fresh-db.ts).
    {{run}} bun run scripts/fresh-db.ts markers
    # Everything drizzle doesn't model (triggers, markers, backfills) lives in
    # the ledger scripts; on a fresh DB they all run, oldest first.
    {{run}} bun run scripts/migrate.ts up --yes

# wipe the local containers' data and build the DB again from scratch
db_reset: nuke
    just target=local db_initiate

# ledger status
db_status:
    {{run}} bun run scripts/migrate.ts status

# run pending ledger scripts (asks first if the target is not dev)
db_migrate:
    {{run}} bun run scripts/migrate.ts up

# create the admin-panel super admin (prompts for a password)
seed_admin *args:
    {{run}} bun run scripts/seed-admin.ts {{args}}

# psql shell into the local container
psql:
    {{compose}} exec postgres psql -U amigo -d amigo_test

# redis-cli into the local container
redis:
    {{compose}} exec redis redis-cli
