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
import { journalEntriesTable } from "./journal-entries";

// A connected bank (Plaid Item) for an org. One live connection per org — the
// access token is server-held and never surfaced to the client. The sync cursor
// makes transactions/sync incremental so re-syncing never re-imports.
export const bankConnectionsTable = pgTable(
  "bank_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    plaidItemId: text("plaid_item_id").notNull(),
    plaidAccessToken: text("plaid_access_token").notNull(),
    institutionName: text("institution_name"),
    cursor: text("cursor"),
    // The one-time opening-balance entry (Dr Cash / Cr Owner's Equity). Set once
    // and preserved across re-links so reconnecting never re-posts it.
    openingBalanceEntryId: uuid("opening_balance_entry_id").references(
      () => journalEntriesTable.id,
    ),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastSyncError: text("last_sync_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique("bank_connections_org_unique").on(t.orgId)],
);

export const insertBankConnectionSchema = createInsertSchema(
  bankConnectionsTable,
).omit({ id: true, createdAt: true });
export type InsertBankConnection = z.infer<typeof insertBankConnectionSchema>;
export type BankConnection = typeof bankConnectionsTable.$inferSelect;
