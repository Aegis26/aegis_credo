import {
  pgTable,
  uuid,
  text,
  timestamp,
  date,
  unique,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";

export const journalEntriesTable = pgTable(
  "journal_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    entryDate: date("entry_date", { mode: "string" }).notNull(),
    memo: text("memo"),
    source: text("source").notNull(),
    // Optional caller-supplied key that makes a posting idempotent within an
    // org. When set, re-posting with the same key returns the existing entry
    // instead of creating a duplicate. Every automated money path (imports,
    // bill pay, invoicing, payroll) supplies one.
    idempotencyKey: text("idempotency_key"),
    // When this entry reverses another, this points at the original entry.
    // The original is never mutated; reversal state is derived from this column.
    reversesEntryId: uuid("reverses_entry_id").references(
      (): AnyPgColumn => journalEntriesTable.id,
    ),
    postedAt: timestamp("posted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Enables composite (org_id, id) foreign keys from journal_lines so a line
    // can never reference an entry belonging to another tenant.
    unique("journal_entries_org_id_unique").on(t.id, t.orgId),
    // Idempotency guard: at most one entry per (org, idempotency_key). NULL
    // keys are unconstrained (manual entries need not supply a key).
    unique("journal_entries_org_idempotency_unique").on(
      t.orgId,
      t.idempotencyKey,
    ),
  ],
);

export const insertJournalEntrySchema = createInsertSchema(
  journalEntriesTable,
).omit({ id: true, postedAt: true, createdAt: true });
export type InsertJournalEntry = z.infer<typeof insertJournalEntrySchema>;
export type JournalEntry = typeof journalEntriesTable.$inferSelect;
