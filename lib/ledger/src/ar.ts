import { and, eq, sql } from "drizzle-orm";
import {
  db,
  invoicesTable,
  invoicePaymentsTable,
  type Invoice,
  type InvoicePayment,
} from "@workspace/db";
import { assertPositiveMoney, type Money } from "./money";
import { NotFoundError } from "./errors";
import {
  postJournalEntry,
  loadPostedEntry,
  type PostedEntry,
  type LedgerTx,
} from "./posting";

export interface CreateInvoiceInput {
  customer: string;
  invoiceNumber?: string;
  invoiceDate: string; // YYYY-MM-DD
  dueDate: string; // YYYY-MM-DD
  amount: Money;
  /** Asset account (Accounts Receivable) debited when the invoice is raised. */
  arAccountId: string;
  /** Revenue account credited when the invoice is raised. */
  revenueAccountId: string;
  externalId?: string;
}

export interface CreatedInvoice {
  invoice: Invoice;
  posted: PostedEntry;
}

/**
 * Raise a customer invoice (accounts receivable): posts Dr A/R / Cr revenue.
 * Idempotent per (org, externalId).
 */
export async function createInvoice(
  orgId: string,
  input: CreateInvoiceInput,
  options: { actor?: string } = {},
): Promise<CreatedInvoice> {
  const amount = assertPositiveMoney(input.amount, "invoice.amount");
  const actor = options.actor ?? "system";

  return db.transaction(async (tx) => {
    if (input.externalId) {
      const [existing] = await tx
        .select()
        .from(invoicesTable)
        .where(
          and(
            eq(invoicesTable.orgId, orgId),
            eq(invoicesTable.externalId, input.externalId),
          ),
        )
        .limit(1);
      if (existing) {
        if (!existing.postedEntryId) {
          throw new NotFoundError("Invoice has no posted entry.");
        }
        const posted = await loadPostedEntry(orgId, existing.postedEntryId, tx);
        return { invoice: existing, posted };
      }
    }

    const [invoice] = await tx
      .insert(invoicesTable)
      .values({
        orgId,
        customer: input.customer,
        invoiceNumber: input.invoiceNumber,
        invoiceDate: input.invoiceDate,
        dueDate: input.dueDate,
        amount,
        arAccountId: input.arAccountId,
        revenueAccountId: input.revenueAccountId,
        externalId: input.externalId,
        status: "open",
      })
      .returning();

    const posted = await postJournalEntry(
      orgId,
      {
        entryDate: input.invoiceDate,
        memo: `Invoice ${input.invoiceNumber ?? invoice.id} — ${input.customer}`,
        source: "ar_invoice",
        lines: [
          { accountId: input.arAccountId, debit: amount },
          { accountId: input.revenueAccountId, credit: amount },
        ],
      },
      { actor, idempotencyKey: `invoice:${invoice.id}`, tx },
    );

    const [updated] = await tx
      .update(invoicesTable)
      .set({ postedEntryId: posted.entry.id })
      .where(eq(invoicesTable.id, invoice.id))
      .returning();

    return { invoice: updated, posted };
  });
}

export interface PayInvoiceInput {
  invoiceId: string;
  paymentDate: string; // YYYY-MM-DD
  amount: Money;
  /** Asset account (Cash/Bank) debited when the payment is received. */
  cashAccountId: string;
  externalId?: string;
}

export interface PaidInvoice {
  payment: InvoicePayment;
  invoice: Invoice;
  posted: PostedEntry;
}

/**
 * Receive (part of) an invoice payment: posts Dr cash / Cr A/R. Idempotent per
 * (org, externalId). Marks the invoice "paid" once payments cover its amount.
 */
export async function payInvoice(
  orgId: string,
  input: PayInvoiceInput,
  options: { actor?: string } = {},
): Promise<PaidInvoice> {
  const amount = assertPositiveMoney(input.amount, "payment.amount");
  const actor = options.actor ?? "system";

  return db.transaction(async (tx) => {
    const [invoice] = await tx
      .select()
      .from(invoicesTable)
      .where(
        and(
          eq(invoicesTable.orgId, orgId),
          eq(invoicesTable.id, input.invoiceId),
        ),
      )
      .limit(1);
    if (!invoice) {
      throw new NotFoundError(`Invoice ${input.invoiceId} not found for org.`);
    }

    if (input.externalId) {
      const [existing] = await tx
        .select()
        .from(invoicePaymentsTable)
        .where(
          and(
            eq(invoicePaymentsTable.orgId, orgId),
            eq(invoicePaymentsTable.externalId, input.externalId),
          ),
        )
        .limit(1);
      if (existing) {
        if (!existing.postedEntryId) {
          throw new NotFoundError("Invoice payment has no posted entry.");
        }
        const posted = await loadPostedEntry(orgId, existing.postedEntryId, tx);
        return { payment: existing, invoice, posted };
      }
    }

    const [payment] = await tx
      .insert(invoicePaymentsTable)
      .values({
        orgId,
        invoiceId: invoice.id,
        paymentDate: input.paymentDate,
        amount,
        cashAccountId: input.cashAccountId,
        externalId: input.externalId,
      })
      .returning();

    const posted = await postJournalEntry(
      orgId,
      {
        entryDate: input.paymentDate,
        memo: `Payment for invoice ${invoice.invoiceNumber ?? invoice.id}`,
        source: "ar_payment",
        lines: [
          { accountId: input.cashAccountId, debit: amount },
          { accountId: invoice.arAccountId, credit: amount },
        ],
      },
      { actor, idempotencyKey: `invoicepay:${payment.id}`, tx },
    );

    const [linkedPayment] = await tx
      .update(invoicePaymentsTable)
      .set({ postedEntryId: posted.entry.id })
      .where(eq(invoicePaymentsTable.id, payment.id))
      .returning();

    const paidSoFar = await sumInvoicePayments(tx, orgId, invoice.id);
    const [updatedInvoice] = await tx
      .update(invoicesTable)
      .set({ status: paidSoFar >= invoice.amount ? "paid" : "open" })
      .where(eq(invoicesTable.id, invoice.id))
      .returning();

    return { payment: linkedPayment, invoice: updatedInvoice, posted };
  });
}

async function sumInvoicePayments(
  tx: LedgerTx,
  orgId: string,
  invoiceId: string,
): Promise<Money> {
  const [row] = await tx
    .select({
      total: sql<string>`COALESCE(SUM(${invoicePaymentsTable.amount}), 0)`,
    })
    .from(invoicePaymentsTable)
    .where(
      and(
        eq(invoicePaymentsTable.orgId, orgId),
        eq(invoicePaymentsTable.invoiceId, invoiceId),
      ),
    );
  return BigInt(row?.total ?? "0");
}

export type AgingBucket =
  | "current"
  | "1-30"
  | "31-60"
  | "61-90"
  | "90+";

export interface AgingLine {
  invoiceId: string;
  customer: string;
  invoiceNumber: string | null;
  dueDate: string;
  outstanding: Money;
  daysPastDue: number;
  bucket: AgingBucket;
}

export interface ArAgingReport {
  asOf: string;
  buckets: Record<AgingBucket, Money>;
  total: Money;
  lines: AgingLine[];
}

const EMPTY_BUCKETS = (): Record<AgingBucket, Money> => ({
  current: 0n,
  "1-30": 0n,
  "31-60": 0n,
  "61-90": 0n,
  "90+": 0n,
});

function bucketFor(daysPastDue: number): AgingBucket {
  if (daysPastDue <= 0) return "current";
  if (daysPastDue <= 30) return "1-30";
  if (daysPastDue <= 60) return "31-60";
  if (daysPastDue <= 90) return "61-90";
  return "90+";
}

function daysBetween(fromISO: string, toISO: string): number {
  const from = Date.parse(`${fromISO}T00:00:00Z`);
  const to = Date.parse(`${toISO}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000);
}

/**
 * Accounts-receivable aging as of a date: outstanding balances of open invoices
 * bucketed by how far past their due date they are. Outstanding is derived from
 * invoice amount minus recorded payments — never a stored balance.
 */
export async function getArAging(
  orgId: string,
  asOf: string,
): Promise<ArAgingReport> {
  const rows = await db
    .select({
      id: invoicesTable.id,
      customer: invoicesTable.customer,
      invoiceNumber: invoicesTable.invoiceNumber,
      dueDate: invoicesTable.dueDate,
      amount: invoicesTable.amount,
    })
    .from(invoicesTable)
    .where(eq(invoicesTable.orgId, orgId));

  const paymentRows = await db
    .select({
      invoiceId: invoicePaymentsTable.invoiceId,
      paid: sql<string>`COALESCE(SUM(${invoicePaymentsTable.amount}), 0)`,
    })
    .from(invoicePaymentsTable)
    .where(eq(invoicePaymentsTable.orgId, orgId))
    .groupBy(invoicePaymentsTable.invoiceId);
  const paidByInvoice = new Map(
    paymentRows.map((p) => [p.invoiceId, BigInt(p.paid)]),
  );

  const buckets = EMPTY_BUCKETS();
  const lines: AgingLine[] = [];
  let total = 0n;

  for (const row of rows) {
    const outstanding = BigInt(row.amount) - (paidByInvoice.get(row.id) ?? 0n);
    if (outstanding <= 0n) continue;
    const daysPastDue = daysBetween(row.dueDate, asOf);
    const bucket = bucketFor(daysPastDue);
    buckets[bucket] += outstanding;
    total += outstanding;
    lines.push({
      invoiceId: row.id,
      customer: row.customer,
      invoiceNumber: row.invoiceNumber,
      dueDate: row.dueDate,
      outstanding,
      daysPastDue,
      bucket,
    });
  }

  return { asOf, buckets, total, lines };
}
