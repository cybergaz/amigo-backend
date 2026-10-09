// Unit tests for the pending (missed WS event) replay order. Pure — no
// database / Redis. Run: `bun test tests/`.
import { describe, expect, test } from "bun:test";
import { sort_pending_for_replay } from "@/utils/pending-order.utils";

const entry = (id: string, type: string, created_at: number) => ({
  message_id: id,
  created_at,
  ws_message: { type },
});

const ids = (entries: { message_id: string }[]) => entries.map((e) => e.message_id);

describe("sort_pending_for_replay", () => {
  test("orders by created_at first", () => {
    const out = sort_pending_for_replay([
      entry("c", "message:new", 3),
      entry("a", "message:new", 1),
      entry("b", "conversation:new", 2),
    ]);
    expect(ids(out)).toEqual(["a", "b", "c"]);
  });

  test("same-ms tie: conversation:new before the message:new that needs it", () => {
    // The order Redis HGETALL / the DB tier may hand them back in.
    const out = sort_pending_for_replay([
      entry("msg", "message:new", 1000),
      entry("conv", "conversation:new", 1000),
    ]);
    expect(ids(out)).toEqual(["conv", "msg"]);
  });

  test("same-ms tie: conversation:new before a group add's conversation:action", () => {
    const out = sort_pending_for_replay([
      entry("action", "conversation:action", 1000),
      entry("conv", "conversation:new", 1000),
    ]);
    expect(ids(out)).toEqual(["conv", "action"]);
  });

  test("never moves conversation:new ahead of an EARLIER event", () => {
    const out = sort_pending_for_replay([
      entry("conv", "conversation:new", 1001),
      entry("msg", "message:new", 1000),
    ]);
    expect(ids(out)).toEqual(["msg", "conv"]);
  });

  test("other same-ms events keep their relative order (stable)", () => {
    const out = sort_pending_for_replay([
      entry("new-1", "message:new", 5),
      entry("delete-1", "message:delete", 5),
      entry("new-2", "message:new", 5),
      entry("conv", "conversation:new", 5),
    ]);
    expect(ids(out)).toEqual(["conv", "new-1", "delete-1", "new-2"]);
  });

  test("empty input", () => {
    expect(sort_pending_for_replay([])).toEqual([]);
  });
});
