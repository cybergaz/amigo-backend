// Unit tests for the sender-identity helpers (src/utils/sender-identity.ts):
// the actor of a send / forward is the AUTHENTICATED user, never an id the
// client put in the payload, and forward_messages' membership gates. No
// database / Redis: the module imports nothing that connects. The DB-backed
// paths (WS + poll message:new, message:forward, forward_messages,
// delete_messages) are exercised end to end on the PGlite harness
// (scratchpad pglite/sender_identity.ts). Run: `bun test tests/`.
import { describe, expect, test } from "bun:test";
import {
  forward_source_floor,
  forward_target_allowed,
  is_own_resend,
  pin_identity,
  pin_refused,
  readable_after_floor,
  same_user_id,
  type ForwarderMembershipRow,
} from "@/utils/sender-identity";
import { snapshot_counters } from "@/utils/counters";

const ME = "5f0c9a2e-8d3b-4f1a-9c7e-0a1b2c3d4e5f";
const OTHER = "6a1d0b3f-9e4c-4a2b-8d8f-1b2c3d4e5f60";
const CHAT = "01925f3a-1b2c-7d4e-9f00-112233445566";

const auth_count = (name: string): number => snapshot_counters().AUTH?.[name] ?? 0;

describe("same_user_id", () => {
  test("case-insensitive uuid compare", () => {
    expect(same_user_id(ME, ME.toUpperCase())).toBe(true);
    expect(same_user_id(ME, OTHER)).toBe(false);
  });
  test("non-strings never match", () => {
    expect(same_user_id(undefined, ME)).toBe(false);
    expect(same_user_id(null, null)).toBe(false);
  });
});

describe("pin_identity", () => {
  test("honest client: id unchanged, not counted", () => {
    const before = auth_count("message_new_spoofed");
    const p = { id: "m1", conv_id: CHAT, sender_id: ME, body: "hi" };
    expect(pin_identity(p, "sender_id", ME, "message_new")).toBe("ok");
    expect(p.sender_id).toBe(ME);
    expect(auth_count("message_new_spoofed")).toBe(before);
  });

  test("upper-cased own id is not a spoof; stored as the authenticated id", () => {
    const p = { sender_id: ME.toUpperCase() };
    expect(pin_identity(p, "sender_id", ME, "message_new")).toBe("ok");
    expect(p.sender_id).toBe(ME);
  });

  test("someone else's id is overwritten in place and counted", () => {
    const before = auth_count("message_new_spoofed");
    const p = { id: "m2", conv_id: CHAT, sender_id: OTHER };
    expect(pin_identity(p, "sender_id", ME, "message_new")).toBe("spoofed");
    expect(p.sender_id).toBe(ME);
    expect(auth_count("message_new_spoofed")).toBe(before + 1);
  });

  test("forwarder_id is pinned the same way", () => {
    const before = auth_count("message_forward_spoofed");
    const p = { source_conv_id: CHAT, forwarder_id: OTHER, forwarded_message_ids: [], target_conv_ids: [] };
    expect(pin_identity(p, "forwarder_id", ME, "message_forward")).toBe("spoofed");
    expect(p.forwarder_id).toBe(ME);
    expect(auth_count("message_forward_spoofed")).toBe(before + 1);
  });

  test("missing / empty id is filled in, not counted", () => {
    const before = auth_count("message_new_spoofed");
    const a: { sender_id?: string } = {};
    const b = { sender_id: "" };
    expect(pin_identity(a, "sender_id", ME, "message_new")).toBe("ok");
    expect(pin_identity(b, "sender_id", ME, "message_new")).toBe("ok");
    expect(a.sender_id).toBe(ME);
    expect(b.sender_id).toBe(ME);
    expect(auth_count("message_new_spoofed")).toBe(before);
  });

  test("no authenticated id: fails CLOSED — refused, counted, client id removed", () => {
    for (const auth of ["", null, undefined]) {
      const before = auth_count("no_identity");
      const p: { sender_id?: string } = { sender_id: OTHER };
      const r = pin_identity(p, "sender_id", auth, "message_new");
      expect(r).toBe("no_identity");
      expect(pin_refused(r)).toBe(true);
      // The client-supplied id must not survive for a caller that ignores r.
      expect(p).not.toHaveProperty("sender_id");
      expect(auth_count("no_identity")).toBe(before + 1);
    }
  });

  test("no authenticated id and no payload: refused, no throw", () => {
    expect(pin_identity(null as { sender_id: string } | null, "sender_id", "", "message_new")).toBe("no_identity");
  });

  test("null payload: refused (nothing to act on), no throw", () => {
    const r = pin_identity(null as { sender_id: string } | null, "sender_id", ME, "message_new");
    expect(r).toBe("no_payload");
    expect(pin_refused(r)).toBe(true);
    expect(pin_refused("ok")).toBe(false);
    expect(pin_refused("spoofed")).toBe(false);
  });
});

const row = (o: Partial<ForwarderMembershipRow>): ForwarderMembershipRow => ({
  chat_id: CHAT,
  chat_type: "group",
  status: "active",
  removed_at: null,
  joined_at: null,
  cleared_at: null,
  ...o,
});

describe("forward_target_allowed", () => {
  test("no membership row → denied", () => {
    expect(forward_target_allowed([])).toBe(false);
  });
  test("active group member → allowed", () => {
    expect(forward_target_allowed([row({})])).toBe(true);
  });
  test("removed group member → denied", () => {
    expect(forward_target_allowed([row({ removed_at: new Date() })])).toBe(false);
  });
  test("left / pending group member → denied", () => {
    expect(forward_target_allowed([row({ status: "left" })])).toBe(false);
    expect(forward_target_allowed([row({ status: "pending" })])).toBe(false);
  });
  test("re-joined member (old removed row + current active row) → allowed", () => {
    expect(forward_target_allowed([
      row({ removed_at: new Date("2026-01-01"), status: "left" }),
      row({}),
    ])).toBe(true);
  });
  test("DM hidden by delete-for-me (removed_at set, status active) → allowed, as the send path", () => {
    expect(forward_target_allowed([row({ chat_type: "dm", removed_at: new Date() })])).toBe(true);
  });
  test("DM with a non-active row → denied", () => {
    expect(forward_target_allowed([row({ chat_type: "dm", status: "left" })])).toBe(false);
  });
});

describe("forward_source_floor / readable_after_floor", () => {
  test("not a member / removed / hidden DM → not readable", () => {
    expect(forward_source_floor([])).toBeNull();
    expect(forward_source_floor([row({ removed_at: new Date() })])).toBeNull();
    expect(forward_source_floor([row({ chat_type: "dm", removed_at: new Date() })])).toBeNull();
    expect(forward_source_floor([row({ status: "left" })])).toBeNull();
  });

  test("floor = max(joined_at, cleared_at)", () => {
    const joined = new Date("2026-10-01T00:00:00Z");
    const cleared = new Date("2026-10-05T00:00:00Z");
    expect(forward_source_floor([row({ joined_at: joined })])!.floor!.getTime()).toBe(joined.getTime());
    expect(forward_source_floor([row({ joined_at: joined, cleared_at: cleared })])!.floor!.getTime())
      .toBe(cleared.getTime());
    expect(forward_source_floor([row({ joined_at: cleared.toISOString(), cleared_at: joined })])!.floor!.getTime())
      .toBe(cleared.getTime());
    expect(forward_source_floor([row({})])!.floor).toBeNull();
  });

  test("only messages strictly after the floor are readable", () => {
    const floor = new Date("2026-10-05T00:00:00Z");
    const msgs = [
      { id: "before", created_at: new Date("2026-10-04T23:59:59Z") },
      { id: "at", created_at: floor },
      { id: "after", created_at: new Date("2026-10-05T00:00:01Z") },
      { id: "null", created_at: null },
    ];
    expect(readable_after_floor(msgs, floor).map((m) => m.id)).toEqual(["after"]);
    expect(readable_after_floor(msgs, null).map((m) => m.id)).toEqual(["before", "at", "after", "null"]);
  });
});

describe("is_own_resend", () => {
  test("same sender + same chat is a resend (case-insensitive)", () => {
    expect(is_own_resend({ sender_id: ME, chat_id: CHAT }, ME, CHAT)).toBe(true);
    expect(is_own_resend({ sender_id: ME, chat_id: CHAT }, ME.toUpperCase(), CHAT.toUpperCase())).toBe(true);
  });
  test("another sender's id, another chat, or a sender-less row is foreign", () => {
    expect(is_own_resend({ sender_id: OTHER, chat_id: CHAT }, ME, CHAT)).toBe(false);
    expect(is_own_resend({ sender_id: ME, chat_id: "01925f3a-0000-7000-8000-000000000000" }, ME, CHAT)).toBe(false);
    expect(is_own_resend({ sender_id: null, chat_id: CHAT }, ME, CHAT)).toBe(false);
  });
});
