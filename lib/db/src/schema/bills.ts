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
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";
import { accountsTable } from "./accounts";
import { journalEntriesTable } from "./journal-entries";

// Accounts payable: a bill owed to a vendor. Recording a bill posts
// Dr expense / Cr accounts-payable through the ledger posting service; the
// resulting entry id is stored in postedEntryId.
export const billsTable = pgTable(
  "bills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    vendor: text("vendor").notNull(),
    billNumber: text("bill_number"),
    billDate: date("bill_date", { mode: "string" }).notNull(),
    dueDate: date("due_date", { mode: "string" }).notNull(),
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    apAccountId: uuid("ap_account_id").notNull(),
    expenseAccountId: uuid("expense_account_id").notNull(),
    status: text("status").notNull().default("open"), // "open" | "paid"
    externalId: text("external_id"),
    postedEntryId: uuid("posted_entry_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("bills_org_id_unique").on(t.id, t.orgId),
    unique("bills_org_external_unique").on(t.orgId, t.externalId),
    foreignKey({
      name: "bills_org_ap_account_fk",
      columns: [t.orgId, t.apAccountId],
      foreignColumns: [accountsTable.orgId, accountsTable.id],
    }),
    foreignKey({
      name: "bills_org_expense_account_fk",
      columns: [t.orgId, t.expenseAccountId],
      foreignColumns: [accountsTable.orgId, accountsTable.id],
    }),
    foreignKey({
      name: "bills_org_entry_fk",
      columns: [t.orgId, t.postedEntryId],
      foreignColumns: [journalEntriesTable.orgId, journalEntriesTable.id],
    }),
  ],
);

export const insertBillSchema = createInsertSchema(billsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertBill = z.infer<typeof insertBillSchema>;
export type Bill = typeof billsTable.$inferSelect;

// A payment against a bill: posts Dr accounts-payable / Cr cash.
export const billPaymentsTable = pgTable(
  "bill_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    billId: uuid("bill_id").notNull(),
    paymentDate: date("payment_date", { mode: "string" }).notNull(),
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    cashAccountId: uuid("cash_account_id").notNull(),
    externalId: text("external_id"),
    postedEntryId: uuid("posted_entry_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("bill_payments_org_external_unique").on(t.orgId, t.externalId),
    foreignKey({
      name: "bill_payments_org_bill_fk",
      columns: [t.orgId, t.billId],
      foreignColumns: [billsTable.orgId, billsTable.id],
    }),
    foreignKey({
      name: "bill_payments_org_cash_account_fk",
      columns: [t.orgId, t.cashAccountId],
      foreignColumns: [accountsTable.orgId, accountsTable.id],
    }),
  ],
);

export const insertBillPaymentSchema = createInsertSchema(billPaymentsTable).omit(
  { id: true, createdAt: true },
);
export type InsertBillPayment = z.infer<typeof insertBillPaymentSchema>;
export type BillPayment = typeof billPaymentsTable.$inferSelect;
