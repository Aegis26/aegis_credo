import {
  pgTable,
  uuid,
  text,
  date,
  bigint,
  timestamp,
  unique,
  foreignKey,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";
import { journalEntriesTable } from "./journal-entries";

// A payroll run ingested from an external provider (Gusto / Check). We do NOT
// compute payroll taxes — we only record the provider's own figures and post
// them to the ledger. The unique (org_id, provider, external_id) makes
// re-ingesting the same provider run idempotent.
export const payrollRunsTable = pgTable(
  "payroll_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    provider: text("provider").notNull(), // "gusto" | "check"
    externalId: text("external_id").notNull(),
    payDate: date("pay_date", { mode: "string" }).notNull(),
    grossPay: bigint("gross_pay", { mode: "bigint" }).notNull(),
    taxes: bigint("taxes", { mode: "bigint" }).notNull(),
    netPay: bigint("net_pay", { mode: "bigint" }).notNull(),
    postedEntryId: uuid("posted_entry_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("payroll_runs_org_provider_external_unique").on(
      t.orgId,
      t.provider,
      t.externalId,
    ),
    foreignKey({
      name: "payroll_runs_org_entry_fk",
      columns: [t.orgId, t.postedEntryId],
      foreignColumns: [journalEntriesTable.orgId, journalEntriesTable.id],
    }),
  ],
);

export const insertPayrollRunSchema = createInsertSchema(payrollRunsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertPayrollRun = z.infer<typeof insertPayrollRunSchema>;
export type PayrollRun = typeof payrollRunsTable.$inferSelect;
