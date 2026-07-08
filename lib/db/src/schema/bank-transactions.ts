import {
  pgTable,
  uuid,
  text,
  timestamp,
  date,
  bigint,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";
import { accountsTable } from "./accounts";
import { journalEntriesTable } from "./journal-entries";

// Schema only for this task — no reconciliation/matching logic is implemented.
export const bankTransactionsTable = pgTable("bank_transactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => organizationsTable.id),
  accountId: uuid("account_id").references(() => accountsTable.id),
  txnDate: date("txn_date", { mode: "string" }).notNull(),
  // Integer minor units (cents); signed. Negative = money out.
  amount: bigint("amount", { mode: "bigint" }).notNull(),
  description: text("description"),
  externalId: text("external_id"),
  matchedEntryId: uuid("matched_entry_id").references(
    () => journalEntriesTable.id,
  ),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertBankTransactionSchema = createInsertSchema(
  bankTransactionsTable,
).omit({ id: true, createdAt: true });
export type InsertBankTransaction = z.infer<typeof insertBankTransactionSchema>;
export type BankTransaction = typeof bankTransactionsTable.$inferSelect;
