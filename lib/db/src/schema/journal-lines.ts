import {
  pgTable,
  uuid,
  text,
  bigint,
  check,
  foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";
import { journalEntriesTable } from "./journal-entries";
import { accountsTable } from "./accounts";
import { dimensionsTable } from "./dimensions";

// Monetary amounts are stored as integer minor units (cents) in bigint columns.
// mode: "bigint" surfaces them as native BigInt in JS so no float/JS number
// ever touches the monetary code path.
export const journalLinesTable = pgTable(
  "journal_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    entryId: uuid("entry_id").notNull(),
    accountId: uuid("account_id").notNull(),
    memo: text("memo"),
    debit: bigint("debit", { mode: "bigint" }).notNull().default(sql`0`),
    credit: bigint("credit", { mode: "bigint" }).notNull().default(sql`0`),
    // Optional reporting dimensions. NULL = untagged, so summing across every
    // value (tagged + untagged) always reconciles back to the trial balance.
    classId: uuid("class_id"),
    departmentId: uuid("department_id"),
    locationId: uuid("location_id"),
    // Set when this line represents activity with another entity in the same
    // parent group. Consolidation eliminates lines whose counterparty is also a
    // group member, so intercompany transactions net to zero on the group books.
    counterpartyOrgId: uuid("counterparty_org_id").references(
      () => organizationsTable.id,
    ),
  },
  (t) => [
    // Composite FKs guarantee a line's account and entry belong to the SAME org
    // as the line — the database itself rejects any cross-tenant reference.
    foreignKey({
      name: "journal_lines_org_account_fk",
      columns: [t.orgId, t.accountId],
      foreignColumns: [accountsTable.orgId, accountsTable.id],
    }),
    foreignKey({
      name: "journal_lines_org_entry_fk",
      columns: [t.orgId, t.entryId],
      foreignColumns: [journalEntriesTable.orgId, journalEntriesTable.id],
    }),
    // Dimensions are org-scoped too: a line can only reference a dimension that
    // belongs to its own org. NULL dimension ids skip the check (MATCH SIMPLE).
    foreignKey({
      name: "journal_lines_org_class_fk",
      columns: [t.orgId, t.classId],
      foreignColumns: [dimensionsTable.orgId, dimensionsTable.id],
    }),
    foreignKey({
      name: "journal_lines_org_department_fk",
      columns: [t.orgId, t.departmentId],
      foreignColumns: [dimensionsTable.orgId, dimensionsTable.id],
    }),
    foreignKey({
      name: "journal_lines_org_location_fk",
      columns: [t.orgId, t.locationId],
      foreignColumns: [dimensionsTable.orgId, dimensionsTable.id],
    }),
    // Amounts are non-negative and a line is exactly one of debit or credit.
    check("journal_lines_non_negative", sql`${t.debit} >= 0 AND ${t.credit} >= 0`),
    check(
      "journal_lines_debit_xor_credit",
      sql`(${t.debit} = 0) <> (${t.credit} = 0)`,
    ),
  ],
);

export const insertJournalLineSchema = createInsertSchema(journalLinesTable).omit(
  { id: true },
);
export type InsertJournalLine = z.infer<typeof insertJournalLineSchema>;
export type JournalLine = typeof journalLinesTable.$inferSelect;
