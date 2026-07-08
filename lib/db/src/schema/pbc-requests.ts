import {
  pgTable,
  uuid,
  text,
  timestamp,
  pgEnum,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";
import { closePeriodsTable } from "./close-periods";
import { usersTable } from "./users";

// A "prepared by client" (PBC) request: the practice asks the client to supply
// something (a document, an answer) needed to finish the close. The client
// responds; the practice accepts. Scoped to the client org.
export const pbcStatusEnum = pgEnum("pbc_status", [
  "requested",
  "provided",
  "accepted",
]);

export const pbcRequestsTable = pgTable("pbc_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => organizationsTable.id),
  periodId: uuid("period_id")
    .notNull()
    .references(() => closePeriodsTable.id),
  title: text("title").notNull(),
  detail: text("detail"),
  status: pbcStatusEnum("status").notNull().default("requested"),
  requestedBy: uuid("requested_by").references(() => usersTable.id),
  response: text("response"),
  respondedAt: timestamp("responded_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertPbcRequestSchema = createInsertSchema(pbcRequestsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertPbcRequest = z.infer<typeof insertPbcRequestSchema>;
export type PbcRequest = typeof pbcRequestsTable.$inferSelect;
export type PbcStatus = (typeof pbcStatusEnum.enumValues)[number];
