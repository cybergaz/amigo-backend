// Isolated harness for tests/socket-identity-gate.test.ts — NOT picked up by a
// plain `bun test` (no .test. in the name); that test runs it in its own
// `bun test` process, because the mock.module() calls below are process-wide
// and would leak into every other test file sharing the module registry.
//
// socket_message_handler (src/sockets/socket.handlers.ts) is loaded with every
// DB / Redis / cluster dependency replaced by an in-memory stub, so the gates
// it owns run for real: refusing message:new / message:forward /
// conversation:typing without an authenticated id, pinning the actor, and
// the typing membership gate. Nothing here connects anywhere.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { snapshot_counters } from "@/utils/counters";

const ME = "5f0c9a2e-8d3b-4f1a-9c7e-0a1b2c3d4e5f";
const OTHER = "6a1d0b3f-9e4c-4a2b-8d8f-1b2c3d4e5f60";
const CHAT = "01925f3a-1b2c-7d4e-9f00-112233445566";
const NOT_MY_CHAT = "01925f3a-1b2c-7d4e-9f00-665544332211";

// What the stubs saw.
type Delivered = { recipients: string[]; frame: Record<string, any> };
const seen = {
  delivered: [] as Delivered[],
  message_new: [] as { payload: any; auth_user_id: string }[],
  forward: [] as { payload: any }[],
};
// chat id -> its member set (stands in for conv.cache).
const members = new Map<string, Set<string>>([[CHAT, new Set([ME, OTHER])]]);

const ok = { success: true, code: 200 };

mock.module("@/cache-management/conv.cache", () => ({
  get_conversation_members: async (chat_id: string) => new Set(members.get(chat_id) ?? []),
  is_member: async (user_id: string, chat_id: string) => members.get(chat_id)?.has(user_id) ?? false,
}));
mock.module("@/cluster/router", () => ({
  deliver: async (recipients: string[], frame: string) => {
    seen.delivered.push({ recipients, frame: JSON.parse(frame) });
    return { online: [], offline: [], polling: [], background: [] };
  },
  is_user_online: async () => false,
}));
mock.module("@/cache-management/polling.cache", () => ({ is_allowed_event: () => false }));
mock.module("@/sockets/socket.server", () => ({ handlePongResponse: () => {} }));
mock.module("@/sockets/connections", () => ({ socket_connections: new Map() }));
mock.module("@/sockets/ws-send", () => ({ ws_send: () => true }));
mock.module("@/sockets/socket.service", () => ({
  handle_message_new: async (payload: any, _name: string, auth_user_id: string) => {
    seen.message_new.push({ payload: { ...payload }, auth_user_id });
    return ok;
  },
  handle_message_forward: async (payload: any) => {
    seen.forward.push({ payload: { ...payload } });
    return ok;
  },
  handle_call_accept: async () => ok,
  handle_call_init: async () => ok,
  handle_call_signaling: async () => ok,
  handle_call_termination: async () => ok,
  handle_connection_status: async () => ok,
  handle_conv_join: async () => ok,
  handle_conv_mark_read: async () => ok,
  handle_message_status_ack: async () => ok,
}));
mock.module("@/services/message.services", () => ({
  pin_message: async () => ok,
  unpin_message: async () => ok,
}));
mock.module("@/services/chat.services", () => ({ soft_delete_message: async () => ok }));

const { socket_message_handler } = await import("@/sockets/socket.handlers");

const auth = (name: string): number => snapshot_counters().AUTH?.[name] ?? 0;
const frame = (type: string, payload: unknown) =>
  ({ type, payload, ws_timestamp: new Date() }) as any;

const new_msg = (sender_id: string) => ({
  id: "0192aaaa-0000-7000-8000-000000000001",
  conv_id: CHAT,
  sender_id,
  type: "text",
  body: "hi",
});
const fwd = (forwarder_id: string) => ({
  source_conv_id: CHAT,
  forwarder_id,
  forwarded_message_ids: ["0192aaaa-0000-7000-8000-000000000002"],
  target_conv_ids: [CHAT],
});
const typing = (conv_id: string, sender_id: string) => ({ conv_id, sender_id, is_typing: true });

beforeEach(() => {
  seen.delivered.length = 0;
  seen.message_new.length = 0;
  seen.forward.length = 0;
});

describe("no authenticated id: fail closed", () => {
  for (const user_id of [undefined, ""]) {
    test(`user_id=${JSON.stringify(user_id)}: message:new / message:forward / typing refused, nothing sent`, async () => {
      const before = auth("no_identity");
      await socket_message_handler({ user_id }, frame("message:new", new_msg(OTHER)));
      await socket_message_handler({ user_id }, frame("message:forward", fwd(OTHER)));
      await socket_message_handler({ user_id }, frame("conversation:typing", typing(CHAT, OTHER)));
      expect(seen.message_new).toHaveLength(0);
      expect(seen.forward).toHaveLength(0);
      // No frame of any kind: there is nobody to address it to, and the typing
      // indicator must not reach the chat as the claimed user.
      expect(seen.delivered).toHaveLength(0);
      expect(auth("no_identity")).toBe(before + 3);
    });
  }
});

describe("authenticated: the actor is pinned", () => {
  test("message:new with someone else's sender_id is sent as the connection's user", async () => {
    await socket_message_handler({ user_id: ME }, frame("message:new", new_msg(OTHER)));
    expect(seen.message_new).toHaveLength(1);
    expect(seen.message_new[0]!.payload.sender_id).toBe(ME);
    expect(seen.message_new[0]!.auth_user_id).toBe(ME);
  });

  test("message:forward with someone else's forwarder_id is forwarded as the connection's user", async () => {
    await socket_message_handler({ user_id: ME }, frame("message:forward", fwd(OTHER)));
    expect(seen.forward).toHaveLength(1);
    expect(seen.forward[0]!.payload.forwarder_id).toBe(ME);
  });

  test("message:new / message:forward without a payload: refused with a socket:error, no auth_error", async () => {
    await socket_message_handler({ user_id: ME }, frame("message:new", null));
    await socket_message_handler({ user_id: ME }, frame("message:forward", undefined));
    expect(seen.message_new).toHaveLength(0);
    expect(seen.forward).toHaveLength(0);
    expect(seen.delivered).toHaveLength(2);
    for (const d of seen.delivered) {
      expect(d.recipients).toEqual([ME]);
      expect(d.frame.type).toBe("socket:error");
      expect(d.frame.payload.code).toBe(400);
      expect(d.frame.payload).not.toHaveProperty("auth_error");
    }
  });
});

describe("conversation:typing membership gate", () => {
  test("a member's typing reaches the other members as the member, never the claimed id", async () => {
    await socket_message_handler({ user_id: ME }, frame("conversation:typing", typing(CHAT, OTHER)));
    expect(seen.delivered).toHaveLength(1);
    const d = seen.delivered[0]!;
    expect(d.frame.type).toBe("conversation:typing");
    expect(d.frame.payload.sender_id).toBe(ME);
    expect(d.recipients).toEqual([OTHER]); // the typer is excluded
  });

  test("a non-member's typing is dropped silently and counted", async () => {
    const before = auth("typing_not_member");
    await socket_message_handler({ user_id: ME }, frame("conversation:typing", typing(NOT_MY_CHAT, ME)));
    await socket_message_handler({ user_id: ME }, frame("conversation:typing", { sender_id: ME }));
    expect(seen.delivered).toHaveLength(0);
    expect(auth("typing_not_member")).toBe(before + 2);
  });

  test("typing without a payload is dropped without an error frame", async () => {
    await socket_message_handler({ user_id: ME }, frame("conversation:typing", null));
    expect(seen.delivered).toHaveLength(0);
  });
});
