import { hostname } from "node:os";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

// =============================================================================
// Worker identity (SYNC_V2 §13.3 identity.ts)
// =============================================================================
// Everything here is computed ONCE at import (boot) time. Nothing shells out
// and nothing touches the network: these values go into every beat, healthz
// response and shutdown log line, so they must be free to read.

const SERVER_PORT = parseInt(process.env.SERVER_PORT || "5000");
const SOCKET_PORT = parseInt(process.env.SOCKET_PORT || "5002");

const HOSTNAME = hostname();

// The slot this process runs in. systemd sets INSTANCE_ID=%i (1, 2, …). The
// tmux deployment sets nothing, so the HTTP port stands in: it is unique per
// process on one box (reusePort is off, a second bind fails), so a restart of
// the same tmux pane is recognised as the SAME slot by the boot guard.
const INSTANCE_ID = (process.env.INSTANCE_ID || "").trim() || String(SERVER_PORT);

// Changes on every process start. UUIDv7's tail is random, so the last 8 hex
// are enough to tell two boots of the same slot apart.
const BOOT_ID = Bun.randomUUIDv7().replace(/-/g, "").slice(-8);

// host:slot — stable across restarts of one slot.
const SLOT_ID = `${HOSTNAME}:${INSTANCE_ID}`;
// host:slot:boot — unique per process; the worker beat is keyed on this.
const WORKER_ID = `${SLOT_ID}:${BOOT_ID}`;

// Namespace for every NEW Redis key (P-9). Dev and prod share one Redis today
// (V14), so dev must not default to prod's namespace. Dev detection matches
// scripts/lib/migration.ts exactly (case-insensitive dev/development/local;
// no APP_ENV + a localhost DB = dev), so a box the ledger treats as dev is
// never "p" here. Keys that a foreign worker must never act on (ring
// deadlines, job markers) also carry DB_FINGERPRINT (keys.ts), so even a
// mis-set REDIS_NS cannot make dev time out prod calls.
const resolve_redis_ns = (): string => {
  const raw = (process.env.REDIS_NS || "").trim();
  if (raw) {
    if (/^[a-z0-9]{1,8}$/i.test(raw)) return raw;
    console.warn(`[CLUSTER] ignoring invalid REDIS_NS "${raw}"`);
  }
  let host = "";
  try {
    host = new URL(process.env.DB_URL || "").hostname;
  } catch { }
  const is_local_host = /^(localhost|127\.0\.0\.1|::1|\[::1\]|0\.0\.0\.0)$/.test(host);
  const env = (process.env.APP_ENV ?? (is_local_host ? "dev" : "prod")).trim().toLowerCase();
  return env === "dev" || env === "development" || env === "local" ? "d" : "p";
};
const REDIS_NS = resolve_redis_ns();

// Which database this worker serves, as a short non-secret hash of
// host:port/dbname (credentials are never hashed in). Two workers are only
// "siblings" when they serve the same DB — the boot guard and the drain's
// sibling check use it so a dev process on the shared Redis can never be
// mistaken for a prod worker (or vice versa), whatever REDIS_NS says.
const db_fingerprint = (): string => {
  const url = process.env.DB_URL || "";
  let basis = url;
  try {
    const u = new URL(url);
    basis = `${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    basis = url.replace(/\/\/[^@]*@/, "//"); // strip user:pass if unparseable
  }
  return createHash("sha256").update(basis).digest("hex").slice(0, 8);
};
const DB_FINGERPRINT = db_fingerprint();

// Release revision, for healthz and the beat (deploy.sh compares it).
// GIT_REV env wins; then a REVISION file (release dirs are archives without
// .git — deploy.sh can write the sha there); then .git/HEAD read directly.
const read_git_rev = (): string => {
  const env_rev = (process.env.GIT_REV || "").trim();
  if (env_rev) return env_rev.slice(0, 40);
  const cwd = process.cwd();
  try {
    const rev_file = join(cwd, "REVISION");
    if (existsSync(rev_file)) {
      const v = readFileSync(rev_file, "utf8").trim();
      if (v) return v.slice(0, 40);
    }
  } catch { }
  try {
    let git_dir = join(cwd, ".git");
    if (!existsSync(git_dir)) return "unknown";
    // A worktree / submodule has a `.git` FILE pointing at the real dir.
    if (statSync(git_dir).isFile()) {
      const m = readFileSync(git_dir, "utf8").match(/gitdir:\s*(.+)/);
      if (!m) return "unknown";
      git_dir = m[1].trim().startsWith("/") ? m[1].trim() : join(cwd, m[1].trim());
    }
    const head = readFileSync(join(git_dir, "HEAD"), "utf8").trim();
    if (!head.startsWith("ref:")) return head.slice(0, 12); // detached
    const ref = head.slice(4).trim();
    const loose = join(git_dir, ref);
    if (existsSync(loose)) return readFileSync(loose, "utf8").trim().slice(0, 12);
    const packed = join(git_dir, "packed-refs");
    if (existsSync(packed)) {
      for (const line of readFileSync(packed, "utf8").split("\n")) {
        const [sha, name] = line.trim().split(" ");
        if (name === ref && sha) return sha.slice(0, 12);
      }
    }
  } catch { }
  return "unknown";
};
const GIT_REV = read_git_rev();

// Until RC-2 (cross-worker routing) ships, more than one live worker per
// deployment loses ~half of all live delivery. The boot guard enforces it.
const CLUSTER_MAX = Math.max(1, parseInt(process.env.CLUSTER_MAX || "1") || 1);

// deploy.sh touches this right before starting the new slot of an A/B swap;
// a second worker is only allowed while it is fresh (boot guard, §13.9.2).
const SWAP_FILE = (process.env.AMIGO_SWAP_FILE || "").trim() || "/run/amigo/swap";

const STARTED_AT = Date.now();

export {
  SERVER_PORT,
  SOCKET_PORT,
  HOSTNAME,
  INSTANCE_ID,
  BOOT_ID,
  SLOT_ID,
  WORKER_ID,
  REDIS_NS,
  DB_FINGERPRINT,
  GIT_REV,
  CLUSTER_MAX,
  SWAP_FILE,
  STARTED_AT,
};
