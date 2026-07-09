import {
  pgTable,
  uuid,
  text,
  timestamp,
  date,
  bigint,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";
import { accountsTable } from "./accounts";
import { journalEntriesTable } from "./journal-entries";

export const bankTransactionsTable = pgTable(
  "bank_transactions",
  {
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
    // Content-based idempotency key so re-linking a bank (which mints fresh
    // Plaid transaction ids) never re-imports the same economic transaction.
    dedupKey: text("dedup_key"),
    // Raw Plaid personal_finance_category, kept for auditability.
    pfcPrimary: text("pfc_primary"),
    pfcDetailed: text("pfc_detailed"),
    // COA code suggested by the shared mapping at import time; null = no guess.
    suggestedAccountCode: text("suggested_account_code"),
    matchedEntryId: uuid("matched_entry_id").references(
      () => journalEntriesTable.id,
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique("bank_transactions_dedup_unique").on(t.orgId, t.dedupKey)],
);

export const insertBankTransactionSchema = createInsertSchema(
  bankTransactionsTable,
).omit({ id: true, createdAt: true });
export type InsertBankTransaction = z.infer<typeof insertBankTransactionSchema>;
export type BankTransaction = typeof bankTransactionsTable.$inferSelect;
