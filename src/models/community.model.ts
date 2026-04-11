import { pgTable, bigint, varchar, timestamp, boolean, jsonb, uuid } from "drizzle-orm/pg-core";
import { user_model } from "./user.model";
import { InferInsertModel, InferSelectModel } from "drizzle-orm";

export const community_model = pgTable("communities", {
  id: uuid().primaryKey().defaultRandom(),
  name: varchar({ length: 255 }).notNull(),
  group_ids: uuid().array(),
  metadata: jsonb(), // For additional community settings
  created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
  deleted_at: timestamp({ withTimezone: true }),
});

// export const community_member_model = pgTable("community_members", {
//   id: bigint({ mode: 'number' }).primaryKey(),
//   community_id: bigint({ mode: 'number' }).references(() => community_model.id, { onDelete: 'cascade' }).notNull(),
//   user_id: bigint({ mode: 'number' }).references(() => user_model.id, { onDelete: 'cascade' }).notNull(),
//   role: varchar({ enum: ["member", "admin"] }).default("member").notNull(),
//   joined_at: timestamp().defaultNow().notNull(),
//   deleted: boolean().default(false).notNull(),
// });

export type CommunityType = InferSelectModel<typeof community_model>;
export type InsertCommunityType = InferInsertModel<typeof community_model>;
export type UpdateCommunityType = Partial<InsertCommunityType>;

// export type CommunityMemberType = InferSelectModel<typeof community_member_model>;
// export type InsertCommunityMemberType = InferInsertModel<typeof community_member_model>;
