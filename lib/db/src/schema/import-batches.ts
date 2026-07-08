import {
  pgTable,
  uuid,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";

// One row per external accounting-file import (QuickBooks Online / Xero).
// externalRef is a stable identifier for the source file (e.g. its content
// hash); the unique constraint makes re-importing the same file idempotent at
// the batch level.
export const importBatchesTable = pgTable(
  "import_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    source: text("source").notNull(), // "quickbooks" | "xero"
    externalRef: text("external_ref").notNull(),
    status: text("status").notNull().default("completed"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("import_batches_org_ref_unique").on(t.orgId, t.externalRef),
  ],
);

export const insertImportBatchSchema = createInsertSchema(
  importBatchesTable,
).omit({ id: true, createdAt: true });
export type InsertImportBatch = z.infer<typeof insertImportBatchSchema>;
export type ImportBatch = typeof importBatchesTable.$inferSelect;
