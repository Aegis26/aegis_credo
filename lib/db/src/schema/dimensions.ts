import { pgTable, uuid, text, timestamp, pgEnum, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";

// Reporting dimensions tag journal lines for slicing reports without changing
// the chart of accounts. Each dimension is one of three kinds and is scoped to
// a single org.
export const dimensionTypeEnum = pgEnum("dimension_type", [
  "class",
  "department",
  "location",
]);

export const dimensionsTable = pgTable(
  "dimensions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    type: dimensionTypeEnum("type").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("dimensions_org_type_name_unique").on(t.orgId, t.type, t.name),
    // Enables composite (org_id, id) foreign keys from journal_lines so a line
    // can never reference a dimension belonging to another tenant.
    unique("dimensions_org_id_unique").on(t.id, t.orgId),
  ],
);

export const insertDimensionSchema = createInsertSchema(dimensionsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertDimension = z.infer<typeof insertDimensionSchema>;
export type Dimension = typeof dimensionsTable.$inferSelect;
export type DimensionType = (typeof dimensionTypeEnum.enumValues)[number];
