// =============================================================================
// Load test: which user ids are test users (+99900…) — for the pending store
// =============================================================================
// Test users created by the load-test tool never connect, poll or ack. Every
// vital event fanned out to them would otherwise be stored for them like for
// any offline member: a Redis pending entry (capped at 500 per user, 1 week)
// and, 10 s later, a missed_ws_messages row kept for 30 DAYS. A 1000-member
// test group with a 5000-message burst is millions of rows nobody will ever
// drain. cluster/router.ts deliver() therefore drops known test users from the
// pending-store recipient list (live delivery is untouched: they have no
// socket anyway).
//
// Cost for real traffic: drop_test_users is synchronous. With no test user
// known (every server that never ran the tool) it returns its argument after
// one size check. The set is filled by the tool when it creates users
// (note_test_users) and refreshed from the DB at most every REFRESH_MS, and
// only while LOAD_TEST_ENABLED is on — so other workers learn ids created on a
// sibling within REFRESH_MS. The refresh never blocks a caller.
// =============================================================================
import { pg_client } from "@/config/db";
import { TEST_PHONE_PREFIX, load_test_enabled } from "./load-test-core";

const REFRESH_MS = 30_000;

let test_ids: Set<string> = new Set();
let next_refresh_at = 0;
let refreshing: Promise<void> | null = null;

/** Add ids the tool just created on this worker (visible at once). */
export const note_test_users = (ids: Iterable<string>): void => {
  for (const id of ids) test_ids.add(id.toLowerCase());
};

/** Re-read every test user id from the DB (awaited by the tool itself). */
export const refresh_test_users = async (): Promise<void> => {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      // LIKE on the literal prefix; the users table is small and this runs
      // at most every REFRESH_MS, only while the tool is enabled.
      const rows = await pg_client<{ id: string }[]>`
        SELECT id::text AS id FROM users WHERE phone LIKE ${TEST_PHONE_PREFIX + "%"}`;
      test_ids = new Set(rows.map((r) => r.id.toLowerCase()));
    } catch (err: any) {
      // Keep the previous set: a missed refresh only delays new ids.
      console.error(`[LOAD-TEST] test user refresh failed: ${err?.message ?? err}`);
    } finally {
      next_refresh_at = Date.now() + REFRESH_MS;
      refreshing = null;
    }
  })();
  return refreshing;
};

const maybe_refresh = (now: number): void => {
  if (now < next_refresh_at || refreshing) return;
  next_refresh_at = now + REFRESH_MS;
  if (!load_test_enabled()) return;
  void refresh_test_users();
};

export const is_known_test_user = (id: string): boolean => test_ids.has(id.toLowerCase());

export const known_test_user_count = (): number => test_ids.size;

/**
 * `recipients` without known test users (the same array when there are none).
 * Used ONLY for the pending store's recipient list.
 */
export const drop_test_users = (recipients: string[]): string[] => {
  maybe_refresh(Date.now());
  if (test_ids.size === 0 || recipients.length === 0) return recipients;
  let any = false;
  for (const id of recipients) {
    if (test_ids.has(id)) { any = true; break; }
  }
  return any ? recipients.filter((id) => !test_ids.has(id)) : recipients;
};
