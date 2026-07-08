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
import { accountsTable } from "./accounts";
import { journalEntriesTable } from "./journal-entries";

// Accounts receivable: an invoice owed by a customer. Recording an invoice
// posts Dr accounts-receivable / Cr revenue through the ledger posting service.
export const invoicesTable = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    customer: text("customer").notNull(),
    invoiceNumber: text("invoice_number"),
    invoiceDate: date("invoice_date", { mode: "string" }).notNull(),
    dueDate: date("due_date", { mode: "string" }).notNull(),
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    arAccountId: uuid("ar_account_id").notNull(),
    revenueAccountId: uuid("revenue_account_id").notNull(),
    status: text("status").notNull().default("open"), // "open" | "paid"
    externalId: text("external_id"),
    postedEntryId: uuid("posted_entry_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("invoices_org_id_unique").on(t.orgId, t.id),
    unique("invoices_org_external_unique").on(t.orgId, t.externalId),
    foreignKey({
      name: "invoices_org_ar_account_fk",
      columns: [t.orgId, t.arAccountId],
      foreignColumns: [accountsTable.orgId, accountsTable.id],
    }),
    foreignKey({
      name: "invoices_org_revenue_account_fk",
      columns: [t.orgId, t.revenueAccountId],
      foreignColumns: [accountsTable.orgId, accountsTable.id],
    }),
    foreignKey({
      name: "invoices_org_entry_fk",
      columns: [t.orgId, t.postedEntryId],
      foreignColumns: [journalEntriesTable.orgId, journalEntriesTable.id],
    }),
  ],
);

export const insertInvoiceSchema = createInsertSchema(invoicesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertInvoice = z.infer<typeof insertInvoiceSchema>;
export type Invoice = typeof invoicesTable.$inferSelect;

// A payment against an invoice: posts Dr cash / Cr accounts-receivable.
export const invoicePaymentsTable = pgTable(
  "invoice_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    invoiceId: uuid("invoice_id").notNull(),
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
    unique("invoice_payments_org_external_unique").on(t.orgId, t.externalId),
    foreignKey({
      name: "invoice_payments_org_invoice_fk",
      columns: [t.orgId, t.invoiceId],
      foreignColumns: [invoicesTable.orgId, invoicesTable.id],
    }),
    foreignKey({
      name: "invoice_payments_org_cash_account_fk",
      columns: [t.orgId, t.cashAccountId],
      foreignColumns: [accountsTable.orgId, accountsTable.id],
    }),
  ],
);

export const insertInvoicePaymentSchema = createInsertSchema(
  invoicePaymentsTable,
).omit({ id: true, createdAt: true });
export type InsertInvoicePayment = z.infer<typeof insertInvoicePaymentSchema>;
export type InvoicePayment = typeof invoicePaymentsTable.$inferSelect;
