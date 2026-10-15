// Sync v2 R1a step (c): the per-chat clock — functions and triggers
// (SYNC_V2_PROTOCOL.md §2.2, §3.2). This file is the SOURCE OF TRUTH for the
// trigger logic; src/models/{message,chat}.model.ts point here.
//
// What it installs (exact names; app code and later phases rely on them):
//
//   amigo_alloc(chat uuid, n int, live_msg uuid) → bigint
//       One UPDATE of the chats row: seq_head += n and, when live_msg is given,
//       last_seq / last_msg_id / last_msg_at move in the SAME tuple version.
//       Returns the new seq_head (the top of the n values), or NULL when the
//       chat is not backfilled (seq_head IS NULL). The row's FOR NO KEY UPDATE
//       lock is held until COMMIT, which is what makes clock values commit in
//       order per chat (§3.2 "commit-order property"). Bulk deletes call it
//       directly with n > 1 under `SET LOCAL amigo.bulk_alloc = 'on'` (§3.3).
//   messages_bi       BEFORE INSERT  → seq = mod_seq = amigo_alloc(chat, 1, id-if-not-deleted)
//                     A caller-supplied seq/mod_seq is ignored. A row whose id
//                     already exists allocates nothing (sequential duplicate).
//   messages_ai_sys   AFTER INSERT WHEN type='system' → settings_seq / roster_seq
//                     from meta->>'action'.
//   messages_bu_del   BEFORE UPDATE OF deleted_at → mod_seq = amigo_alloc(chat,1,NULL)
//                     on the first soft delete (skipped under amigo.bulk_alloc).
//   messages_au_del   AFTER UPDATE OF deleted_at → rewinds last_seq/last_msg_id
//                     when the pointed-to row died; clears pinned_msg_id when the
//                     pinned row died (which fires chats_bu_pin).
//   messages_ad_ptr   AFTER DELETE (statement) → same repair for HARD deletes.
//   chats_bu_pin      BEFORE UPDATE OF pinned_msg_id → seq_head += 1, pin_seq = seq_head.
//   chat_members_seq  BEFORE INSERT/UPDATE OF status, removed_at, joined_at →
//                     joined_seq / read_seq / delivered_seq floors on a FRESH join,
//                     left_seq when leaving 'active' (numbered chats only) and
//                     left_at (always), cleared again on a fresh join.
//   amigo_refresh_min_wm(chat uuid) → void
//       Recomputes chat_receipt_mins for one chat under a per-chat advisory lock.
//   chat_members_minwm(_stmt/_ins/_del) → refresh mins on membership changes,
//                     once per chat per statement, chats in id order.
//
// Only chats with seq_head IS NOT NULL are touched. Until the backfill numbers
// a chat, every trigger is a no-op for it and the legacy writers own its
// pointers, so installing this before the backfill changes nothing visible.
//
// PRECONDITIONS: sync_v2_schema (20261020a) AND sync_v2_code_deployed (the
// R1a build is live; it boots on 20261020a/b alone). Ship order is a/b →
// code → c (§9 row 2). With the OLD build still running, the triggers plus
// seq_head DEFAULT 0 would number every new chat while that build's
// unguarded pointer writers (sent_at-ordered repoint, the multi-chat sweeper
// UPDATE) keep writing them — so a bare `script:migrate up` stops here.
//
// Re-runnable: functions are CREATE OR REPLACE (catalog only, no table lock).
// Each trigger carries a version comment; it is dropped and recreated (short
// lock_timeout, retried) only when that version changes. Finally sets
// chats.seq_head DEFAULT 0 so chats created from now on are born numbered —
// AFTER the triggers exist, so no chat can be born numbered without them.
import { skipIfApplied, recordApplied } from "../lib/migration";
import {
  MARKERS, column_exists, ddl, open_sql, require_marker, set_marker, trigger_comment, with_lock_retry,
} from "../lib/sync-v2";

await skipIfApplied(import.meta.path);

// Bump when a CREATE TRIGGER line below changes (event, columns, WHEN,
// level). Function bodies need no bump: CREATE OR REPLACE swaps them in place.
// v2: chat_members_minwm became row-collect + statement-level refresh
// (new trigger chat_members_minwm_stmt).
const TRIGGER_VERSION = "sync-v2 triggers v2";

const FUNCTIONS = String.raw`
-- ── Allocation ────────────────────────────────────────────────────────────
-- ONE UPDATE (FOR NO KEY UPDATE: compatible with the FK KEY SHARE locks that
-- inserts referencing chats take) that also moves the last-message pointer.
CREATE OR REPLACE FUNCTION amigo_alloc(p_chat uuid, p_n int, p_live_msg uuid) RETURNS bigint
LANGUAGE sql VOLATILE AS $fn$
  UPDATE chats SET seq_head = seq_head + p_n,
         last_seq    = CASE WHEN p_live_msg IS NOT NULL THEN seq_head + p_n ELSE last_seq END,
         last_msg_id = CASE WHEN p_live_msg IS NOT NULL THEN p_live_msg ELSE last_msg_id END,
         last_msg_at = CASE WHEN p_live_msg IS NOT NULL THEN now() ELSE last_msg_at END
   WHERE id = p_chat AND seq_head IS NOT NULL
  RETURNING seq_head;
$fn$;

-- Shared by the insert and delete triggers. A NULL from amigo_alloc means "not
-- numbered in my snapshot". The backfill's final step numbers a chat while
-- holding its row FOR UPDATE, and an UPDATE whose WHERE fails in its snapshot
-- never waits for that lock — so a row written in that window would commit
-- unnumbered into a numbered chat. Taking FOR KEY SHARE (the lock the FK check
-- takes anyway) waits for that step to commit, and the retry then sees
-- seq_head; or it gets in first, and the backfill then waits for US and numbers
-- our row itself. Costs one extra row lock only on chats not yet backfilled.
CREATE OR REPLACE FUNCTION amigo_alloc_settled(p_chat uuid, p_n int, p_live_msg uuid) RETURNS bigint
LANGUAGE plpgsql VOLATILE AS $fn$
DECLARE v bigint;
BEGIN
  v := amigo_alloc(p_chat, p_n, p_live_msg);
  IF v IS NULL THEN
    PERFORM 1 FROM chats WHERE id = p_chat FOR KEY SHARE;
    v := amigo_alloc(p_chat, p_n, p_live_msg);
  END IF;
  RETURN v;
END $fn$;

CREATE OR REPLACE FUNCTION trg_messages_bi() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF current_setting('amigo.seq_backfill', true) = 'on' THEN RETURN NEW; END IF;
  NEW.seq := NULL; NEW.mod_seq := NULL;                -- never trust a caller-supplied seq
  -- Sequential duplicate (client retry, GC verify): allocate nothing; the
  -- INSERT then hits the PK conflict and the caller re-selects the original seq.
  IF EXISTS (SELECT 1 FROM messages WHERE id = NEW.id) THEN RETURN NEW; END IF;
  -- Concurrent duplicate (same id sent over WS and poll at once): take the
  -- chat lock first — it waits for the other insert to commit — then look
  -- again. Without this the loser would burn a value AND move last_seq to a
  -- seq that names no row (its INSERT then does nothing). Same lock the
  -- allocation below takes anyway; numbered chats only.
  PERFORM 1 FROM chats WHERE id = NEW.chat_id AND seq_head IS NOT NULL FOR NO KEY UPDATE;
  IF FOUND AND EXISTS (SELECT 1 FROM messages WHERE id = NEW.id) THEN RETURN NEW; END IF;
  NEW.seq := amigo_alloc_settled(NEW.chat_id, 1, CASE WHEN NEW.deleted_at IS NULL THEN NEW.id END);
  NEW.mod_seq := NEW.seq;
  RETURN NEW;
END $fn$;

-- Persisted system rows (§3.10) bump the settings / roster versions.
CREATE OR REPLACE FUNCTION trg_messages_ai_sys() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.type = 'system' AND NEW.seq IS NOT NULL AND NEW.meta IS NOT NULL THEN
    UPDATE chats SET
      settings_seq = CASE WHEN NEW.meta->>'action' IN ('chat_details:update','disappearing','owner')
                          THEN GREATEST(settings_seq, NEW.seq) ELSE settings_seq END,
      roster_seq   = CASE WHEN NEW.meta->>'action' IN ('add','remove','leave','role','owner','join')
                          THEN GREATEST(roster_seq, NEW.seq) ELSE roster_seq END
     WHERE id = NEW.chat_id;
  END IF;
  RETURN NULL;
END $fn$;

-- First soft delete (or expiry) of a numbered row takes a fresh clock value.
CREATE OR REPLACE FUNCTION trg_messages_bu_del() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL AND NEW.seq IS NOT NULL
     AND current_setting('amigo.bulk_alloc', true) IS DISTINCT FROM 'on' THEN
    NEW.mod_seq := COALESCE(amigo_alloc_settled(NEW.chat_id, 1, NULL), NEW.mod_seq);
  END IF;
  RETURN NEW;
END $fn$;

-- Pointer repair after a soft delete. Numbered chats only: for a chat that is
-- not backfilled yet the legacy broadcast_deletion() reads last_msg_id AFTER
-- the delete to decide whether to repoint; touching it here would hide the hit
-- from that code and leave the chat with no pointer at all.
-- When nothing visible is left, last_msg_at is kept so the chat holds its
-- place in the list (same as the legacy writer).
CREATE OR REPLACE FUNCTION trg_messages_au_del() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    UPDATE chats c
       SET last_seq = x.seq, last_msg_id = x.id, last_msg_at = COALESCE(x.created_at, c.last_msg_at)
      FROM (SELECT 1) one
      LEFT JOIN LATERAL (
        SELECT m.seq, m.id, m.created_at FROM messages m
         WHERE m.chat_id = NEW.chat_id AND m.deleted_at IS NULL AND m.seq IS NOT NULL
           AND (m.expires_at IS NULL OR m.expires_at > now())
         ORDER BY m.seq DESC LIMIT 1) x ON true
     WHERE c.id = NEW.chat_id AND c.last_msg_id = NEW.id AND c.seq_head IS NOT NULL;
    UPDATE chats SET pinned_msg_id = NULL                      -- fires chats_bu_pin
     WHERE id = NEW.chat_id AND pinned_msg_id = NEW.id AND seq_head IS NOT NULL;
  END IF;
  RETURN NULL;
END $fn$;

-- Same repair for HARD deletes (admin hard delete until it becomes soft, §3.3.3).
-- Statement level: a chat deletion cascades thousands of rows, and its chats
-- row is already gone, so this is one cheap no-op join there.
CREATE OR REPLACE FUNCTION trg_messages_ad_ptr() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  UPDATE chats c
     SET last_seq = x.seq, last_msg_id = x.id, last_msg_at = COALESCE(x.created_at, c.last_msg_at)
    FROM (SELECT DISTINCT o.chat_id, o.id FROM amigo_old_messages o) d
    LEFT JOIN LATERAL (
      SELECT m.seq, m.id, m.created_at FROM messages m
       WHERE m.chat_id = d.chat_id AND m.deleted_at IS NULL AND m.seq IS NOT NULL
         AND (m.expires_at IS NULL OR m.expires_at > now())
       ORDER BY m.seq DESC LIMIT 1) x ON true
   WHERE c.id = d.chat_id AND c.last_msg_id = d.id AND c.seq_head IS NOT NULL;
  UPDATE chats c SET pinned_msg_id = NULL
    FROM amigo_old_messages o
   WHERE c.id = o.chat_id AND c.pinned_msg_id = o.id AND c.seq_head IS NOT NULL;
  RETURN NULL;
END $fn$;

-- Every pin change is a clock allocation: pin_seq orders pins against messages.
CREATE OR REPLACE FUNCTION trg_chats_bu_pin() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.pinned_msg_id IS DISTINCT FROM OLD.pinned_msg_id AND NEW.seq_head IS NOT NULL THEN
    NEW.seq_head := NEW.seq_head + 1;
    NEW.pin_seq := NEW.seq_head;
  END IF;
  RETURN NEW;
END $fn$;

-- Membership floors. FRESH JOIN only: INSERT as active, a status transition
-- into 'active', or a joined_at change (the group re-add path resets
-- joined_at). A DM revive (removed_at cleared) is NOT a join (PD-6): the
-- hidden peer keeps its watermarks. Written with explicit TG_OP branches so
-- OLD is never read on INSERT.
CREATE OR REPLACE FUNCTION trg_chat_members_seq() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE h bigint; t text; fresh boolean := false; leaving boolean := false;
BEGIN
  IF NEW.status = 'active' AND NEW.removed_at IS NULL THEN
    IF TG_OP = 'INSERT' THEN
      fresh := true;
    ELSIF OLD.status IS DISTINCT FROM 'active' OR NEW.joined_at IS DISTINCT FROM OLD.joined_at THEN
      SELECT type INTO t FROM chats WHERE id = NEW.chat_id;
      fresh := t IS DISTINCT FROM 'dm';
    END IF;
  END IF;
  IF NOT fresh AND TG_OP = 'UPDATE' AND OLD.status = 'active' AND NEW.status <> 'active' THEN
    leaving := true;
  END IF;
  IF fresh OR leaving THEN
    -- Waits for in-flight allocations, so the floor is a committed head. NO KEY
    -- UPDATE rather than the spec's FOR SHARE: a transaction that changes a
    -- membership and then allocates (add member + persisted system row) would
    -- otherwise upgrade SHARE → NO KEY UPDATE, and two such transactions on one
    -- chat deadlock. NO KEY UPDATE is still compatible with the FK KEY SHARE locks.
    SELECT seq_head INTO h FROM chats WHERE id = NEW.chat_id FOR NO KEY UPDATE;
    IF fresh THEN
      -- Unnumbered chat: 0 is the neutral floor; 20261022 raises joined_seq
      -- from joined_at once the backfill has numbered the chat.
      NEW.joined_seq := COALESCE(h, 0); NEW.left_seq := NULL; NEW.left_at := NULL;
      NEW.read_seq := GREATEST(NEW.read_seq, COALESCE(h, 0));
      NEW.delivered_seq := GREATEST(NEW.delivered_seq, COALESCE(h, 0));
    ELSE
      -- clock_timestamp, not now(): rows committed by transactions that
      -- began before this one but finished first are "before the leave".
      NEW.left_at := clock_timestamp();
      IF h IS NOT NULL THEN NEW.left_seq := h; END IF;
    END IF;
    -- Leaving an unnumbered chat stamps no left_seq: 0 would freeze the shell
    -- empty for good (a shell shows seq <= left_seq). NULL + left_at lets
    -- 20261022 resolve it (max seq created at/before left_at) once the chat
    -- is numbered.
  END IF;
  RETURN NEW;
END $fn$;

-- Two lowest read / delivered values per chat over COUNTED members: active,
-- user_id NOT NULL, and (removed_at IS NULL OR the chat is a DM — a hidden DM
-- peer is still the recipient). Broadcast lists have no mins (§3.8).
CREATE OR REPLACE FUNCTION amigo_refresh_min_wm(p_chat uuid) RETURNS void
LANGUAGE plpgsql AS $fn$
DECLARE t text;
BEGIN
  SELECT type INTO t FROM chats WHERE id = p_chat;
  -- No chats row: the chat is being deleted (cascade) — inserting a mins row
  -- for it would fail the FK and abort the delete.
  IF NOT FOUND OR t = 'broadcast' THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('minwm:' || p_chat::text));
  INSERT INTO chat_receipt_mins AS x (chat_id, r_min1, r_min1_user, r_min2, d_min1, d_min1_user, d_min2, updated_at)
  SELECT p_chat,
         COALESCE((array_agg(r ORDER BY r, user_id))[1], 0), (array_agg(user_id ORDER BY r, user_id))[1],
         (array_agg(r ORDER BY r, user_id))[2],
         COALESCE((array_agg(d ORDER BY d, user_id))[1], 0), (array_agg(user_id ORDER BY d, user_id))[1],
         (array_agg(d ORDER BY d, user_id))[2], now()
    FROM (SELECT cm.user_id,
                 GREATEST(cm.read_seq, cm.joined_seq) AS r,
                 GREATEST(cm.delivered_seq, cm.read_seq, cm.joined_seq) AS d
            FROM chat_members cm
           WHERE cm.chat_id = p_chat AND cm.status = 'active' AND cm.user_id IS NOT NULL
             AND (cm.removed_at IS NULL OR t = 'dm')) s
  ON CONFLICT (chat_id) DO UPDATE SET
     r_min1 = excluded.r_min1, r_min1_user = excluded.r_min1_user, r_min2 = excluded.r_min2,
     d_min1 = excluded.d_min1, d_min1_user = excluded.d_min1_user, d_min2 = excluded.d_min2,
     updated_at = now();
END $fn$;

-- Membership changes refresh mins inline (rare events): leave, remove,
-- hide/revive, account deletion (user_id SET NULL). Once per STATEMENT, not
-- per row: a group delete flips N rows of one chat (N refreshes each
-- aggregating N rows, under the chat lock), and account deletion / bulk kick
-- touch many chats in physical row order — per-row refreshes would take the
-- per-chat advisory locks in that order and deadlock against the sorted mins
-- runner. Transition tables would do this directly, but PG refuses them on a
-- trigger with a column list, and without one every receipt UPDATE would pay
-- for capturing them. So the row trigger (filtered by its WHEN) only notes
-- the chat id in a transaction-local setting, and the statement trigger
-- refreshes those chats once each, in id order. A savepoint rollback also
-- rolls the setting back.
CREATE OR REPLACE FUNCTION trg_chat_members_minwm() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE cur text := COALESCE(current_setting('amigo.minwm_pending', true), '');
BEGIN
  IF position(NEW.chat_id::text IN cur) = 0 THEN cur := cur || NEW.chat_id::text || ','; END IF;
  IF OLD.chat_id IS DISTINCT FROM NEW.chat_id AND position(OLD.chat_id::text IN cur) = 0 THEN
    cur := cur || OLD.chat_id::text || ',';
  END IF;
  PERFORM set_config('amigo.minwm_pending', cur, true);
  RETURN NULL;
END $fn$;

CREATE OR REPLACE FUNCTION trg_chat_members_minwm_stmt() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE cur text := COALESCE(current_setting('amigo.minwm_pending', true), ''); c uuid;
BEGIN
  IF cur = '' THEN RETURN NULL; END IF;
  PERFORM set_config('amigo.minwm_pending', '', true);
  FOR c IN SELECT DISTINCT x::uuid FROM unnest(string_to_array(rtrim(cur, ','), ',')) AS x ORDER BY 1 LOOP
    PERFORM amigo_refresh_min_wm(c);
  END LOOP;
  RETURN NULL;
END $fn$;

-- INSERT / DELETE at statement level with transition tables: a group created
-- with N members or a chat deleted with N members is ONE refresh per chat, not
-- N refreshes each aggregating N rows. Chats in id order to keep the advisory
-- locks ordered across concurrent statements.
CREATE OR REPLACE FUNCTION trg_chat_members_minwm_ins() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE c uuid;
BEGIN
  FOR c IN SELECT DISTINCT chat_id FROM amigo_new_members ORDER BY 1 LOOP
    PERFORM amigo_refresh_min_wm(c);
  END LOOP;
  RETURN NULL;
END $fn$;

CREATE OR REPLACE FUNCTION trg_chat_members_minwm_del() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE c uuid;
BEGIN
  FOR c IN SELECT DISTINCT chat_id FROM amigo_old_members ORDER BY 1 LOOP
    PERFORM amigo_refresh_min_wm(c);
  END LOOP;
  RETURN NULL;
END $fn$;
`;

// [table, trigger name, CREATE TRIGGER statement]
const TRIGGERS: [string, string, string][] = [
  ["messages", "messages_bi",
    `CREATE TRIGGER messages_bi BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION trg_messages_bi()`],
  ["messages", "messages_ai_sys",
    `CREATE TRIGGER messages_ai_sys AFTER INSERT ON messages FOR EACH ROW WHEN (NEW.type = 'system') EXECUTE FUNCTION trg_messages_ai_sys()`],
  ["messages", "messages_bu_del",
    `CREATE TRIGGER messages_bu_del BEFORE UPDATE OF deleted_at ON messages FOR EACH ROW EXECUTE FUNCTION trg_messages_bu_del()`],
  ["messages", "messages_au_del",
    `CREATE TRIGGER messages_au_del AFTER UPDATE OF deleted_at ON messages FOR EACH ROW
       WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL) EXECUTE FUNCTION trg_messages_au_del()`],
  ["messages", "messages_ad_ptr",
    `CREATE TRIGGER messages_ad_ptr AFTER DELETE ON messages REFERENCING OLD TABLE AS amigo_old_messages
       FOR EACH STATEMENT EXECUTE FUNCTION trg_messages_ad_ptr()`],
  ["chats", "chats_bu_pin",
    `CREATE TRIGGER chats_bu_pin BEFORE UPDATE OF pinned_msg_id ON chats FOR EACH ROW EXECUTE FUNCTION trg_chats_bu_pin()`],
  ["chat_members", "chat_members_seq",
    `CREATE TRIGGER chat_members_seq BEFORE INSERT OR UPDATE OF status, removed_at, joined_at ON chat_members
       FOR EACH ROW EXECUTE FUNCTION trg_chat_members_seq()`],
  ["chat_members", "chat_members_minwm",
    `CREATE TRIGGER chat_members_minwm AFTER UPDATE OF status, removed_at, user_id, chat_id ON chat_members FOR EACH ROW
       WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.removed_at IS DISTINCT FROM NEW.removed_at
             OR OLD.user_id IS DISTINCT FROM NEW.user_id OR OLD.chat_id IS DISTINCT FROM NEW.chat_id)
       EXECUTE FUNCTION trg_chat_members_minwm()`],
  // Same column list as the row trigger above: it fires for every statement
  // that can have fired that one, and for no receipt write.
  ["chat_members", "chat_members_minwm_stmt",
    `CREATE TRIGGER chat_members_minwm_stmt AFTER UPDATE OF status, removed_at, user_id, chat_id ON chat_members
       FOR EACH STATEMENT EXECUTE FUNCTION trg_chat_members_minwm_stmt()`],
  ["chat_members", "chat_members_minwm_ins",
    `CREATE TRIGGER chat_members_minwm_ins AFTER INSERT ON chat_members REFERENCING NEW TABLE AS amigo_new_members
       FOR EACH STATEMENT EXECUTE FUNCTION trg_chat_members_minwm_ins()`],
  ["chat_members", "chat_members_minwm_del",
    `CREATE TRIGGER chat_members_minwm_del AFTER DELETE ON chat_members REFERENCING OLD TABLE AS amigo_old_members
       FOR EACH STATEMENT EXECUTE FUNCTION trg_chat_members_minwm_del()`],
];

const sql = open_sql(1);
let succeeded = false;
try {
  await require_marker(sql, MARKERS.schema, "run 20261020a-sync-v2-columns first");
  await require_marker(sql, MARKERS.code_deployed, "deploy the R1a build first (it boots on 20261020a/b alone)");
  for (const [t, c] of [["messages", "seq"], ["chats", "seq_head"], ["chat_members", "joined_seq"]] as const) {
    if (!(await column_exists(sql, t, c))) throw new Error(`precondition failed: ${t}.${c} missing — run 20261020a`);
  }

  // Functions: catalog-only, no lock on the tables. Always replaced, so a fixed
  // body ships by re-running this script with --force.
  await with_lock_retry(sql, "functions", (tx) => tx.unsafe(FUNCTIONS));
  console.log("  ✔ functions created / replaced");

  // A chat can only hold seq_head = 0 before messages_bi exists if something
  // applied the DEFAULT early (a db:push from the new models). Such a chat
  // would be skipped by the backfill with unnumbered rows, so put it back to
  // "not backfilled" — safe only while messages_bi does not exist yet, because
  // until then nothing has allocated a single value. Same transaction as the
  // trigger creation, so no insert can slip between the two.
  const bi_installed = (await trigger_comment(sql, "messages", "messages_bi")) !== undefined;

  for (const [table, name, create] of TRIGGERS) {
    const current = await trigger_comment(sql, table, name);
    if (current === TRIGGER_VERSION) {
      console.log(`  ✔ trigger ${name} up to date`);
      continue;
    }
    await with_lock_retry(sql, `trigger ${name}`, async (tx) => {
      if (name === "messages_bi" && !bi_installed) {
        const reset = await tx`UPDATE chats SET seq_head = NULL WHERE seq_head IS NOT NULL`;
        if (reset.count > 0) console.warn(`  ⚠️  reset ${reset.count} chat(s) numbered before the triggers existed`);
      }
      // DROP takes ACCESS EXCLUSIVE briefly; only reached on first install or
      // a TRIGGER_VERSION bump. lock_timeout + retry bounds the stall.
      await tx.unsafe(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
      await tx.unsafe(create);
      await tx.unsafe(`COMMENT ON TRIGGER ${name} ON ${table} IS '${TRIGGER_VERSION}'`);
    });
    console.log(`  ✔ trigger ${name} ${current === undefined ? "created" : "recreated"}`);
  }

  // Last: new chats are born numbered (seq_head 0) now that allocation exists.
  await ddl(sql, `ALTER TABLE chats ALTER COLUMN seq_head SET DEFAULT 0`);

  await set_marker(sql, MARKERS.triggers, 1);
  console.log(`✅ sync v2 functions + triggers installed (re-runnable). Marker ${MARKERS.triggers}=1.`);
  succeeded = true;
} catch (e) {
  console.error("❌ sync v2 triggers failed:", e);
} finally {
  await sql.end();
}

if (succeeded) await recordApplied(import.meta.path);
process.exit(succeeded ? 0 : 1);
