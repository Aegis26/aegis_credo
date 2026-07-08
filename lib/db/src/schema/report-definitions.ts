import { pgTable, uuid, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";
import { usersTable } from "./users";

// A saved custom report: the query (group-by dimensions + filters) is stored as
// JSON so users can build and re-run reports without exporting to a spreadsheet.
export const reportDefinitionsTable = pgTable("report_definitions", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => organizationsTable.id),
  name: text("name").notNull(),
  definition: jsonb("definition").notNull(),
  createdBy: uuid("created_by").references(() => usersTable.id),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertReportDefinitionSchema = createInsertSchema(
  reportDefinitionsTable,
).omit({ id: true, createdAt: true });
export type InsertReportDefinition = z.infer<
  typeof insertReportDefinitionSchema
>;
export type ReportDefinitionRow = typeof reportDefinitionsTable.$inferSelect;
