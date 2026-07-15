import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// A parent group owns multiple organizations (entities). Consolidation is a
// read-only reporting layer over the member entities' independent ledgers — the
// group itself has no ledger and never mutates an entity's books.
export const groupsTable = pgTable("groups", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  // Who created the group. A freshly created group has no member orgs yet, so
  // membership-derived listing alone would make it invisible to its creator —
  // this column lets the creator see (and populate) an empty group.
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertGroupSchema = createInsertSchema(groupsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertGroup = z.infer<typeof insertGroupSchema>;
export type Group = typeof groupsTable.$inferSelect;
