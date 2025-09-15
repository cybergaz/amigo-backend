import { Elysia, t } from "elysia";
import { app_middleware } from "@/middleware";
import db from "@/config/db";
import { conversation_model, conversation_member_model, message_model } from "@/models/chat.model";
import { eq, and, desc, sql } from "drizzle-orm";

const chat_routes = new Elysia({ prefix: "/chat" })
  .state({ id: 0, role: "" })
  .guard({
    beforeHandle({ cookie, set, store, headers }) {
      const state_result = app_middleware({ cookie, headers });

      set.status = state_result.code;
      if (!state_result.data) return state_result

      store.id = state_result.data.id;
      store.role = state_result.data.role;
    }
  })

  // Get user's conversations
  .get("/conversations", async ({ set, store }) => {
    try {
      const conversations = await db
        .select({
          id: conversation_model.id,
          type: conversation_model.type,
          title: conversation_model.title,
          metadata: conversation_model.metadata,
          last_message_at: conversation_model.last_message_at,
          created_at: conversation_model.created_at,
          unread_count: conversation_member_model.unread_count,
          last_read_message_id: conversation_member_model.last_read_message_id
        })
        .from(conversation_model)
        .innerJoin(
          conversation_member_model,
          eq(conversation_model.id, conversation_member_model.conversation_id)
        )
        .where(
          and(
            eq(conversation_member_model.user_id, store.id),
            eq(conversation_model.deleted, false)
          )
        )
        .orderBy(desc(conversation_model.last_message_at));

      return {
        success: true,
        data: conversations
      };
    } catch (error) {
      console.error("Error fetching conversations:", error);
      set.status = 500;
      return { success: false, message: "Failed to fetch conversations" };
    }
  })

  // Get messages for a conversation
  .get("/conversations/:id/messages", async ({ params, set, store, query }) => {
    try {
      const conversation_id = Number(params.id);
      const limit = Number(query.limit) || 50;
      const offset = Number(query.offset) || 0;

      // Verify user is member of conversation
      const membership = await db
        .select()
        .from(conversation_member_model)
        .where(
          and(
            eq(conversation_member_model.conversation_id, conversation_id),
            eq(conversation_member_model.user_id, store.id)
          )
        )
        .limit(1);

      if (membership.length === 0) {
        set.status = 403;
        return { success: false, message: "Not authorized to view this conversation" };
      }

      const messages = await db
        .select({
          id: message_model.id,
          conversation_id: message_model.conversation_id,
          sender_id: message_model.sender_id,
          type: message_model.type,
          body: message_model.body,
          attachments: message_model.attachments,
          metadata: message_model.metadata,
          edited_at: message_model.edited_at,
          created_at: message_model.created_at,
          sender_name: sql<string>`users.name`
        })
        .from(message_model)
        .innerJoin(sql`users`, eq(sql`users.id`, message_model.sender_id))
        .where(
          and(
            eq(message_model.conversation_id, conversation_id),
            eq(message_model.deleted, false)
          )
        )
        .orderBy(desc(message_model.created_at))
        .limit(limit)
        .offset(offset);

      return {
        success: true,
        data: messages.reverse() // Return in chronological order
      };
    } catch (error) {
      console.error("Error fetching messages:", error);
      set.status = 500;
      return { success: false, message: "Failed to fetch messages" };
    }
  }, {
    params: t.Object({
      id: t.String()
    }),
    query: t.Object({
      limit: t.Optional(t.String()),
      offset: t.Optional(t.String())
    })
  })

  // Create a new conversation (DM or Group)
  .post("/conversations", async ({ body, set, store }) => {
    try {
      const { type, title, member_ids } = body as {
        type: "dm" | "group";
        title?: string;
        member_ids: number[];
      };

      if (!member_ids || member_ids.length === 0) {
        set.status = 400;
        return { success: false, message: "At least one member is required" };
      }

      // Add creator to member list
      const all_member_ids = [store.id, ...member_ids.filter(id => id !== store.id)];

      // Create conversation
      const new_conversation = await db
        .insert(conversation_model)
        .values({
          creater_id: store.id,
          type,
          title: type === "group" ? title : null,
          metadata: type === "dm" ? { is_dm: true } : {}
        })
        .returning();

      const conversation_id = new_conversation[0].id;

      // Add members to conversation
      const members = all_member_ids.map((user_id, index) => ({
        conversation_id,
        user_id,
        role: user_id === store.id ? "admin" : "member"
      }));

      await db.insert(conversation_member_model).values(members);

      return {
        success: true,
        data: {
          id: conversation_id,
          type,
          title,
          member_count: all_member_ids.length
        }
      };
    } catch (error) {
      console.error("Error creating conversation:", error);
      set.status = 500;
      return { success: false, message: "Failed to create conversation" };
    }
  }, {
    body: t.Object({
      type: t.Union([t.Literal("dm"), t.Literal("group")]),
      title: t.Optional(t.String()),
      member_ids: t.Array(t.Number())
    })
  })

  // Add member to conversation
  .post("/conversations/:id/members", async ({ params, body, set, store }) => {
    try {
      const conversation_id = Number(params.id);
      const { user_id } = body as { user_id: number };

      // Verify user is admin of conversation
      const membership = await db
        .select()
        .from(conversation_member_model)
        .where(
          and(
            eq(conversation_member_model.conversation_id, conversation_id),
            eq(conversation_member_model.user_id, store.id)
          )
        )
        .limit(1);

      if (membership.length === 0 || membership[0].role !== "admin") {
        set.status = 403;
        return { success: false, message: "Not authorized to add members" };
      }

      // Check if user is already a member
      const existing_member = await db
        .select()
        .from(conversation_member_model)
        .where(
          and(
            eq(conversation_member_model.conversation_id, conversation_id),
            eq(conversation_member_model.user_id, user_id)
          )
        )
        .limit(1);

      if (existing_member.length > 0) {
        set.status = 400;
        return { success: false, message: "User is already a member" };
      }

      // Add member
      await db
        .insert(conversation_member_model)
        .values({
          conversation_id,
          user_id,
          role: "member"
        });

      return {
        success: true,
        message: "Member added successfully"
      };
    } catch (error) {
      console.error("Error adding member:", error);
      set.status = 500;
      return { success: false, message: "Failed to add member" };
    }
  }, {
    params: t.Object({
      id: t.String()
    }),
    body: t.Object({
      user_id: t.Number()
    })
  })

  // Mark messages as read
  .post("/conversations/:id/read", async ({ params, body, set, store }) => {
    try {
      const conversation_id = Number(params.id);
      const { message_id } = body as { message_id: number };

      // Update read receipt
      await db
        .update(conversation_member_model)
        .set({
          last_read_message_id: message_id,
          unread_count: 0
        })
        .where(
          and(
            eq(conversation_member_model.conversation_id, conversation_id),
            eq(conversation_member_model.user_id, store.id)
          )
        );

      return {
        success: true,
        message: "Messages marked as read"
      };
    } catch (error) {
      console.error("Error marking messages as read:", error);
      set.status = 500;
      return { success: false, message: "Failed to mark messages as read" };
    }
  }, {
    params: t.Object({
      id: t.String()
    }),
    body: t.Object({
      message_id: t.Number()
    })
  });

export default chat_routes;

