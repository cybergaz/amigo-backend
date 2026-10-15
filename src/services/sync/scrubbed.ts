// =============================================================================
// Scrubbed tombstones (SYNC_V2_PROTOCOL.md §3.3.3)
// =============================================================================
// The admin "permanent delete" used to DELETE the row; it now soft-deletes and
// scrubs it (body + attachments NULL) so v2 clients learn of it through the
// delta. Readers that used to see "no row" must keep seeing no row:
//   - reply previews: a reply to an admin-removed message got
//     `replied_to_message: null`; an empty {body:null, attachments:null}
//     preview would render as an empty (or attachment-less image) quote;
//   - the admin conversation viewer: the message disappeared and the total
//     dropped; it must not come back blank after a refresh.
// A user's delete-for-everyone keeps its body, so it is NOT matched here and
// those readers behave exactly as before. No live message has neither a body
// nor attachments, which is what makes the pair a safe signature.
import { sql, type SQL } from "drizzle-orm";
import { message_model } from "@/models/message.model";

export const not_scrubbed_tombstone = (): SQL =>
  sql`NOT (${message_model.deleted_at} IS NOT NULL AND ${message_model.body} IS NULL AND ${message_model.attachments} IS NULL)`;
