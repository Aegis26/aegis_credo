import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  pgEnum,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";
import { closePeriodsTable } from "./close-periods";
import { usersTable } from "./users";

// A single checklist item within a client's month-end close (e.g. "Reconcile
// bank", "Review AR aging"). Status tracking drives the period's overall
// progress. Scoped to the client org.
export const closeTaskStatusEnum = pgEnum("close_task_status", [
  "pending",
  "in_progress",
  "done",
]);

export const closeTasksTable = pgTable("close_tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => organizationsTable.id),
  periodId: uuid("period_id")
    .notNull()
    .references(() => closePeriodsTable.id),
  title: text("title").notNull(),
  status: closeTaskStatusEnum("status").notNull().default("pending"),
  sortOrder: integer("sort_order").notNull().default(0),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  completedBy: uuid("completed_by").references(() => usersTable.id),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertCloseTaskSchema = createInsertSchema(closeTasksTable).omit({
  id: true,
  createdAt: true,
});
export type InsertCloseTask = z.infer<typeof insertCloseTaskSchema>;
export type CloseTask = typeof closeTasksTable.$inferSelect;
export type CloseTaskStatus = (typeof closeTaskStatusEnum.enumValues)[number];
