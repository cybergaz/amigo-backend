# Local dev stack: Postgres + Redis in Docker (docker-compose.local.yml).
#
# Every recipe here runs against the LOCAL containers. DB_URL / REDIS_URL are
# exported below and win over .env (dotenv and Bun's .env loading never
# override variables already in the environment), so .env keeps pointing at
# the shared dev DB for everything you run outside `just`.

compose := "docker compose -f docker-compose.local.yml"

export DB_URL := "postgres://amigo:amigo@127.0.0.1:55432/amigo_test"
export REDIS_URL := "redis://127.0.0.1:56379"
export APP_ENV := "dev"

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

# bun dev (watch mode) against the local containers
dev: up
    bun run dev

# create every table, then run all one-off ledger scripts (sync v2 triggers etc.)
db_initiate: up
    # Tables, enums and indexes straight from src/models. Safe here only because
    # the DB is local and empty — never push a shared DB (see drizzle.config.ts).
    bunx drizzle-kit push --force
    # The sync v2 scripts wait for two markers a deployed server writes at boot
    # (code_deployed, dualwrite). They guard against legacy code still running
    # against live data; a fresh empty DB has neither, so write them up front.
    {{compose}} exec -T postgres psql -U amigo -d amigo_test -v ON_ERROR_STOP=1 -q -c \
      "INSERT INTO app_settings (key, value, updated_at) VALUES \
         ('sync_v2_code_deployed', '{\"by\":\"just db_initiate\"}', now()), \
         ('sync_v2_dualwrite',     '{\"by\":\"just db_initiate\"}', now()) \
       ON CONFLICT (key) DO NOTHING"
    # Everything drizzle doesn't model (triggers, markers, backfills) lives in
    # the ledger scripts; on a fresh DB they all run, oldest first.
    bun run scripts/migrate.ts up --yes
    @echo "local DB ready: $DB_URL"

# wipe the local DB and build it again from scratch
db_reset: nuke db_initiate

# ledger status for the local DB
db_status:
    bun run scripts/migrate.ts status

# create the admin-panel super admin in the local DB (prompts for a password)
seed_admin *args:
    bun run scripts/seed-admin.ts {{args}}

# psql shell into the local DB
psql:
    {{compose}} exec postgres psql -U amigo -d amigo_test

# redis-cli into the local Redis
redis:
    {{compose}} exec redis redis-cli
