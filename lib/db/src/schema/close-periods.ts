import {
  pgTable,
  uuid,
  text,
  timestamp,
  pgEnum,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";
import { usersTable } from "./users";

// Month-end close for a single client org. A period (e.g. "2026-01") tracks the
// state of the close through its checklist tasks and PBC requests. Scoped to the
// client org; all transitions are audit-logged against it.
export const closeStatusEnum = pgEnum("close_status", [
  "open",
  "in_progress",
  "in_review",
  "closed",
]);

export const closePeriodsTable = pgTable(
  "close_periods",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    period: text("period").notNull(), // e.g. "2026-01"
    status: closeStatusEnum("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: uuid("closed_by").references(() => usersTable.id),
  },
  (t) => [unique("close_periods_org_period_unique").on(t.orgId, t.period)],
);

export const insertClosePeriodSchema = createInsertSchema(
  closePeriodsTable,
).omit({ id: true, createdAt: true });
export type InsertClosePeriod = z.infer<typeof insertClosePeriodSchema>;
export type ClosePeriod = typeof closePeriodsTable.$inferSelect;
export type CloseStatus = (typeof closeStatusEnum.enumValues)[number];
