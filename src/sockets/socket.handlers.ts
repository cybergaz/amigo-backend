import {
  WebSocketData,
  WSMessage,
  ConnectionStatusPayload,
  ChatMessagePayload,
  TypingPayload,
  MessagePinPayload,
  MessageForwardPayload,
  VitalWSMessage,
  CallPayload,
  ALLOWED_WS_EVENTS_WITHOUT_PAYLOAD,
  type AllowedWSEventsWithoutPayloadType,
  ConvJoinPayload,
  MessageStatusAckPayload,
  DeleteMessagePayload,
} from "@/types/socket.types";
import { ElysiaWS } from "elysia/dist/ws";
import { get_conversation_members, is_member } from "@/cache-management/conv.cache";
import { handlePongResponse } from "./socket.server";
import { socket_connections } from "./connections";
import { is_allowed_event } from "@/cache-management/polling.cache";
import { deliver, is_user_online } from "@/cluster/router";
import { fanout_frames } from "@/cluster/router-core";
import {
  handle_call_accept,
  handle_call_init,
  handle_call_signaling,
  handle_call_termination,
  // handle_call_hold, handle_call_connected, handle_call_rejoin_open, handle_call_rejoin_resolved,
  handle_connection_status,
  handle_message_forward,
  handle_message_new,
  handle_conv_join,
  handle_conv_mark_read,
  handle_message_status_ack,
} from "./socket.service";
import { pin_message, unpin_message } from "@/services/message.services";
import { soft_delete_message } from "@/services/chat.services";
import { ws_send } from "./ws-send";
import { pin_identity, pin_refused, type PinResult } from "@/utils/sender-identity";
import { count } from "@/utils/counters";

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

const set_ws_data = (ws: ElysiaWS, data: WebSocketData) => {
  Object.assign(ws.data, data);
};

const get_ws_data = (ws: ElysiaWS, key: keyof WebSocketData) => {
  return (ws.data as WebSocketData)[key];
};

type BroadcastData = {
  to: "conversation" | "users";
  conv_id?: string;
  user_ids?: string[];
  message: WSMessage;
  exclude_user_ids?: string[];
  // SYNC_V2 §3.12: the frame sent to LIVE sockets when it must differ from
  // the stored one (message:pin's pinned_message travels on the live WS
  // only — never into the pending store, polling replies or FCM). The
  // pending store always gets `message`.
  live_message?: WSMessage;
};

// Fire a message to EVERY client connected to THIS instance. Used for global,
// non-vital broadcasts (e.g. the marquee banner) where there is no conversation
// or user-list scope. Cross-instance fan-out is handled by the Redis pub/sub in
// ws-broadcast.ts, which calls this on each instance. Intentionally lightweight:
// no offline persistence (transient config — clients re-fetch on next launch).
const broadcast_to_all = (message: WSMessage) => {
  const serialized = JSON.stringify(message);
  for (const [user_id, connection] of socket_connections) {
    if (connection.ws.readyState !== 1) continue;
    // ws_send never throws and records backpressure/drops (§14.5 item 4).
    ws_send(connection.ws, serialized, connection, user_id);
  }
};

const broadcast_message = async (data: BroadcastData) => {
  let members: string[] = [];
  if (data.to === "conversation" && data.conv_id) {
    // Get conversation members (LRU -> Redis -> DB)
    members = Array.from(await get_conversation_members(data.conv_id));
  }

  // sent to both specific users and conversation members (if both conv_id & user_ids are provided)
  // Filter out falsy ids defensively — callers sometimes coerce a nullable
  // sender_id to "" before passing it in (system messages have sender_id=NULL),
  // and "" downstream lands in the uuid-typed missed_ws_messages.user_id and
  // crashes the worker.
  const excluded = data.exclude_user_ids?.length ? new Set(data.exclude_user_ids) : null;
  const recipients_list = Array.from(
    new Set([...members, ...(data.user_ids ? data.user_ids : [])]),
  ).filter((id) => !!id && !excluded?.has(id));

  // Delivery and FCM classification live in the router (SYNC_V2 §13.6,
  // RC-2): local sockets first (synchronously, no Redis), then pollers /
  // other workers / offline per CLUSTER_ROUTING. Vital events are stored in
  // the pending queue for EVERY recipient (store-for-everyone: a ws.send
  // into a ghost connection "succeeds", so online is not proof of delivery);
  // drained by delivery acks.
  // Return shape unchanged: { online, offline, polling, background }.
  // `background` ⊆ online ∪ polling: users who get the live frame AND an
  // FCM push (only handle_message_new consumes it — every other caller
  // ignores it, so non-message events are never pushed).
  const { live, store } = fanout_frames(data.message, data.live_message);
  return deliver(
    recipients_list,
    live,
    is_allowed_event(store.type) ? (store as VitalWSMessage) : undefined,
  );
};

// A message:new / message:forward frame pin_identity refused. With no
// authenticated id there is nobody to tell (pin_identity counted
// AUTH/no_identity): send nothing. With a missing payload the sender gets the
// usual socket:error (no auth_error field: it is a bad frame, never a logout).
const refuse_unpinned_frame = async (user_id: string, result: PinResult, event: string) => {
  if (result === "no_identity" || !user_id) return;
  count("AUTH", "no_payload");
  // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
  await broadcast_message({
    to: "users",
    user_ids: [user_id],
    message: {
      type: "socket:error",
      payload: {
        code: 400,
        message: `Invalid ${event} payload`,
      },
      ws_timestamp: new Date(),
    },
  });
};

const socket_message_handler = async (
  user_details: {
    user_id?: string;
    user_name?: string;
    // user_pfp?: string;
  },
  message: WSMessage,
): Promise<MessageNewResult | undefined> => {
  // message:new only: the handler's result, whose data.sent_ack is the ack
  // the sender got — POST /chat/poll/send-message returns it (§4.1).
  let sent_result: MessageNewResult | undefined;
  const user_id = user_details.user_id || "";
  const user_name = user_details.user_name || "Unknown User";
  // const user_pfp = user_details.user_pfp || "";

  if (!user_id) {
    // No authenticated identity: refuse EVERY frame (fail closed). There is
    // nobody to address an error frame to (it used to be "sent" to user_ids
    // [""], which delivered nothing), so just count + log. The auth layer
    // (socket open / poll guard) owns telling the client to re-authenticate.
    count("AUTH", "no_identity");
    console.warn(`[AUTH] ${message?.type}: no authenticated user id; frame refused`);
    return;
  }

  try {
    // Basic validation
    if (
      !message.payload &&
      !ALLOWED_WS_EVENTS_WITHOUT_PAYLOAD.includes(
        message.type as AllowedWSEventsWithoutPayloadType,
      )
    ) {
      console.error(`[WS] Message payload missing for type ${message.type}`);
    }

    // Handle incoming messages
    switch (message.type) {
      // ----------------------------------------------------
      case "connection:status": {
        // --------------------------------------------------
        // sender_id pinned to the authenticated id — the payload's must not be
        // able to flip someone else's background flag / presence.
        const result = await handle_connection_status({
          ...(message.payload as ConnectionStatusPayload),
          sender_id: user_id,
        });
        if (!result.success) {
          // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
          await broadcast_message({
            to: "users",
            user_ids: [user_id],
            message: {
              type: "socket:error",
              payload: {
                code: result.code || 500,
                message: result.message || "Error updating connection status",
                error: result.error,
              },
              ws_timestamp: new Date(),
            },
          });
        }
        break;
      }

      // ----------------------------------------------------
      case "conversation:join": {
        // -------------------------------------------------- // case 'conversation:leave':
        // Identity comes from the authenticated connection, never the payload.
        const result = await handle_conv_join(
          { ...(message.payload as ConvJoinPayload), user_id },
          message.ws_timestamp,
        );
        if (!result.success) {
          // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
          await broadcast_message({
            to: "users",
            user_ids: [user_id],
            message: {
              type: "socket:error",
              payload: {
                code: result.code || 500,
                message:
                  result.message || "Error handling conversation join/leave",
                error: result.error,
              },
              ws_timestamp: new Date(),
            },
          });
        }
        break;
      }

      // ----------------------------------------------------
      case "conversation:mark_read": {
        // --------------------------------------------------
        // Identity comes from the authenticated connection, never the payload.
        const result = await handle_conv_mark_read(
          { ...(message.payload as ConvJoinPayload), user_id },
          message.ws_timestamp,
        );
        if (!result.success) {
          // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
          await broadcast_message({
            to: "users",
            user_ids: [user_id],
            message: {
              type: "socket:error",
              payload: {
                code: result.code || 500,
                message:
                  result.message || "Error handling conversation mark-read",
                error: result.error,
              },
              ws_timestamp: new Date(),
            },
          });
        }
        break;
      }

      // ----------------------------------------------------
      case "conversation:typing": {
        // --------------------------------------------------
        const payload = message.payload as TypingPayload;
        // The typer is the authenticated connection, never payload.sender_id.
        // Ephemeral: a refused frame is dropped without an error frame.
        if (pin_refused(pin_identity(payload, "sender_id", user_id, "conversation_typing"))) break;
        // Only a member may type into a chat (it was broadcast to ANY conv_id's
        // members). Same cached helper as message:new's send guard: the
        // member set broadcast_message loads below anyway, so a warm cache
        // costs no extra round trip. No DB fallback (typing is not worth one):
        // a user re-opening a DM they hid shows as typing once they send.
        if (typeof payload.conv_id !== "string" || !(await is_member(user_id, payload.conv_id))) {
          count("AUTH", "typing_not_member");
          break;
        }

        // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
        await broadcast_message({
          to: "conversation",
          conv_id: payload.conv_id,
          message: {
            type: "conversation:typing",
            payload: payload,
            ws_timestamp: new Date(),
          },
          exclude_user_ids: [payload.sender_id],
        });

        break;
      }

      // ----------------------------------------------------
      case "message:new": {
        // --------------------------------------------------
        // The sender is the authenticated user of this connection (WS) or
        // request (POST /chat/poll/send-message), never payload.sender_id —
        // which used to be trusted, so anyone could send as anyone. Pinned in
        // place: store, acks and fan-out all read payload.sender_id. A no-op
        // for an honest client (it sends its own id).
        const pinned = pin_identity(message.payload as ChatMessagePayload, "sender_id", user_id, "message_new");
        if (pin_refused(pinned)) {
          await refuse_unpinned_frame(user_id, pinned, "message:new");
          break;
        }
        const result = sent_result = await handle_message_new(
          message.payload as ChatMessagePayload,
          user_name,
          // Authenticated id of this connection — the broadcast-list branch
          // still re-checks payload.sender_id against it (defence in depth).
          user_id,
        );
        // console.log("result -> ", result);
        if (!result.success) {
          // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
          await broadcast_message({
            to: "users",
            user_ids: [user_id],
            message: {
              type: "socket:error",
              payload: {
                code: result.code || 500,
                message: result.message || "Error handling new message",
                error: result.error,
              },
              ws_timestamp: new Date(),
            },
          });
        }
        break;
      }

      // ----------------------------------------------------
      case "message:status:ack": {
        // --------------------------------------------------
        const result = await handle_message_status_ack(
          message.payload as MessageStatusAckPayload,
          user_id,
          message.ws_timestamp,
        );
        // console.log("result -> ", result);
        if (!result.success) {
          // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
          await broadcast_message({
            to: "users",
            user_ids: [user_id],
            message: {
              type: "socket:error",
              payload: {
                code: result.code || 500,
                message: result.message || "Error handling message status ack",
                error: result.error,
              },
              ws_timestamp: new Date(),
            },
          });
        }
        break;
      }

      // ----------------------------------------------------
      case "message:delete": {
        // --------------------------------------------------
        // Delete-for-everyone over the WS — the offline-replayable path
        // for the client's vital-event outbox. Previously this frame hit
        // `default:` and was DROPPED as unhandled; only the HTTP route
        // actually deleted, so an offline delete died at the API gate and
        // was never replayed. soft_delete_message enforces sender
        // ownership + active membership (elevation is derived server-side
        // from the authenticated user's role — the payload's
        // is_admin_or_staff is ignored) and fans out via broadcast_deletion
        // (WS + FCM + last-msg/pin repoint), excluding the actor. Outbox
        // replays are idempotent: already-deleted rows match nothing, so
        // there is no double fan-out.
        const payload = message.payload as DeleteMessagePayload;
        const ids = Array.isArray(payload?.message_ids)
          ? payload.message_ids
          : [];
        if (ids.length > 0) {
          await soft_delete_message(ids, user_id);
        }
        break;
      }

      // ----------------------------------------------------
      case "message:pin": {
        // --------------------------------------------------
        const payload = message.payload as MessagePinPayload;

        // validate → commit → broadcast ONCE (SYNC_V2 R0). The raw payload
        // used to be re-broadcast here BEFORE validation/commit, so receivers
        // applied pins that were then rejected (phantom pins / unpins). Now
        // pin_message / unpin_message are the only broadcasters, and only of
        // committed state. The actor is the AUTHENTICATED id of this
        // connection, never payload.sender_id.
        const pin_data = {
          conv_id: payload.conv_id,
          message_id: payload.message_id,
          user_id: user_id,
        };
        // update in DB (+ committed broadcast inside)
        const result = payload.pin
          ? await pin_message(pin_data)
          : await unpin_message(pin_data);

        if (!result.success) {
          // Rejected (403/404/409/...) — nothing was broadcast; tell the actor only.
          // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
          await broadcast_message({
            to: "users",
            user_ids: [user_id],
            message: {
              type: "socket:error",
              payload: {
                code: result.code || 500,
                message: result.message || "Error handling message pin",
              },
              ws_timestamp: new Date(),
            },
          });
        }

        break;
      }

      // ----------------------------------------------------
      case "message:forward": {
        // --------------------------------------------------
        // The forwarder is the authenticated user, never payload.forwarder_id
        // (it becomes the forwarded rows' sender_id and the actor of every
        // membership gate in forward_messages).
        const pinned = pin_identity(message.payload as MessageForwardPayload, "forwarder_id", user_id, "message_forward");
        if (pin_refused(pinned)) {
          await refuse_unpinned_frame(user_id, pinned, "message:forward");
          break;
        }
        const result = await handle_message_forward(
          message.payload as MessageForwardPayload,
          user_name,
        );
        if (!result.success) {
          // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
          await broadcast_message({
            to: "users",
            user_ids: [user_id],
            message: {
              type: "socket:error",
              payload: {
                code: result.code || 500,
                message: result.message || "Error handling new message",
                error: result.error,
              },
              ws_timestamp: new Date(),
            },
          });
        }
        break;
      }

      // ----------------------------------------------------
      case "call:init": {
        // --------------------------------------------------
        // console.log("call:init payload -> ", message.payload);
        const result = await handle_call_init(
          message.payload as CallPayload,
          user_id,
          user_name,
          // user_pfp
        );
        if (!result.success) {
          // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
          await broadcast_message({
            to: "users",
            user_ids: [user_id],
            message: {
              type: "socket:error",
              payload: {
                code: result.code || 500,
                message: result.message || "Error initiating call init",
                error: result.error,
              },
              ws_timestamp: new Date(),
            },
          });
        }
        break;
      }

      // Forward WebRTC signaling between caller and callee
      // ----------------------------------------------------
      case "call:offer":
      case "call:answer":
      case "call:ice": {
        // --------------------------------------------------
        const result = await handle_call_signaling(
          message.payload as CallPayload,
          message.type,
          user_id,
        );
        if (!result.success) {
          // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
          await broadcast_message({
            to: "users",
            user_ids: [user_id],
            message: {
              type: "socket:error",
              payload: {
                code: result.code || 500,
                message: result.message || "Error handling call signaling",
                error: result.error,
              },
              ws_timestamp: new Date(),
            },
          });
        }
        break;
      }

      // ----------------------------------------------------
      case "call:accept": {
        // --------------------------------------------------
        const result = await handle_call_accept(
          message.payload as CallPayload,
          user_id,
        );
        if (!result.success) {
          // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
          await broadcast_message({
            to: "users",
            user_ids: [user_id],
            message: {
              type: "socket:error",
              payload: {
                code: result.code || 500,
                message: result.message || "Error accepting call",
                error: result.error,
              },
              ws_timestamp: new Date(),
            },
          });
        }
        break;
      }

      // ----------------------------------------------------
      // case 'call:hold':
      //   // --------------------------------------------------
      //   {
      //     const result = await handle_call_hold(message.payload as CallPayload, user_id);
      //     if (!result.success) {
      //       await broadcast_message({
      //         to: "users",
      //         user_ids: [user_id],
      //         message: {
      //           type: "socket:error",
      //           payload: { code: result.code || 500, message: result.message || "Error handling call:hold", error: result.error },
      //           ws_timestamp: new Date()
      //         }
      //       });
      //     }
      //     break;
      //   }

      // ----------------------------------------------------
      case "call:terminate": {
        // --------------------------------------------------
        // console.log("call:terminate payload -> ", message.payload);
        const result = await handle_call_termination(
          message.payload as CallPayload,
          message.type,
          user_id,
        );
        if (!result.success) {
          // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
          await broadcast_message({
            to: "users",
            user_ids: [user_id],
            message: {
              type: "socket:error",
              payload: {
                code: result.code || 500,
                message: result.message || "Error terminating call",
                error: result.error,
              },
              ws_timestamp: new Date(),
            },
          });
        }
        break;
      }

      // // ----------------------------------------------------
      // case 'call:connected':
      //   // --------------------------------------------------
      //   // App reports a Stream call reached CONNECTED — record the in-call
      //   // pairing so a later socket close can self-open a rejoin window
      //   // without relying on Stream webhooks. Fire-and-forget.
      //   {
      //     await handle_call_connected(message.payload as CallPayload, user_id);
      //     break;
      //   }

      // // ----------------------------------------------------
      // case 'call:rejoin:open':
      // case 'call:rejoin:resolved':
      //   // --------------------------------------------------
      //   {
      //     const result = message.type === 'call:rejoin:open'
      //       ? await handle_call_rejoin_open(message.payload as CallPayload, user_id)
      //       : await handle_call_rejoin_resolved(message.payload as CallPayload, user_id);
      //     if (!result.success) {
      //       await broadcast_message({
      //         to: "users",
      //         user_ids: [user_id],
      //         message: {
      //           type: "socket:error",
      //           payload: {
      //             code: result.code || 500,
      //             message: result.message || `Error handling ${message.type}`,
      //             error: result.error,
      //           },
      //           ws_timestamp: new Date()
      //         }
      //       });
      //     }
      //     break;
      //   }

      // ----------------------------------------------------
      case "socket:health_check": {
        // --------------------------------------------------
        // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
        await broadcast_message({
          to: "users",
          user_ids: [user_id],
          message: {
            type: "socket:health_check",
            payload: {
              message: "Connection is healthy",
              code: 1,
            },
            ws_timestamp: new Date(),
          },
        });
        break;
      }

      // ----------------------------------------------------
      case "socket:ping": {
        // --------------------------------------------------
        // WebSocket pings never get here: socket.server.ts answers them
        // directly on the socket they arrived on (SYNC_V2 §14.5). This branch
        // is only reachable from the HTTP long-polling path (chat-poll.routes)
        // and is kept unchanged for it.
        // Client sent ping, respond with pong
        // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
        await broadcast_message({
          to: "users",
          user_ids: [user_id],
          message: {
            type: "socket:pong",
            ws_timestamp: new Date(),
          },
        });

        break;
      }

      // ----------------------------------------------------
      case "socket:pong": {
        // --------------------------------------------------
        // Client responded to our ping - reset missed ping counter
        handlePongResponse(user_id);
        break;
      }

      default: {
        console.warn(`[WS] Unhandled message type: ${message.type}`);
        // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
        await broadcast_message({
          to: "users",
          user_ids: [user_id],
          message: {
            type: "socket:error",
            payload: {
              message: `Unhandled message type: ${message.type}`,
              code: 1006,
            },
            ws_timestamp: new Date(),
          },
        });
        break;
      }
    }
  } catch (error) {
    console.error("[WS] Error processing message:", error);
    // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
    await broadcast_message({
      to: "users",
      user_ids: [user_id],
      message: {
        type: "socket:error",
        payload: {
          message: "Error processing your message",
          code: 1007,
          error: error as any,
        },
        ws_timestamp: new Date(),
      },
    });
  }
  return sent_result;
};

type MessageNewResult = Awaited<ReturnType<typeof handle_message_new>>;

export {
  set_ws_data,
  get_ws_data,
  is_user_online,
  broadcast_message,
  broadcast_to_all,
  // get_connected_users,
  // handle_join_conversation,
  socket_message_handler,
  // convertBigIntIdsToString,
  // convertStringIdsToBigInt,
  // convertStringIdsToBigIntForWSMessage
};
