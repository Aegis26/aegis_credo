import { and, eq, sql } from "drizzle-orm";
import {
  db,
  billsTable,
  billPaymentsTable,
  type Bill,
  type BillPayment,
} from "@workspace/db";
import { assertPositiveMoney, type Money } from "./money";
import { NotFoundError } from "./errors";
import {
  postJournalEntry,
  loadPostedEntry,
  type PostedEntry,
  type LedgerTx,
} from "./posting";
import { evaluateApproval, requireApproved, getApproval } from "./approvals";
import type { Approval } from "@workspace/db";

/** The entity type used for bill approval rules. */
export const BILL_APPROVAL_ENTITY = "bill";

export interface CreateBillInput {
  vendor: string;
  billNumber?: string;
  billDate: string; // YYYY-MM-DD
  dueDate: string; // YYYY-MM-DD
  amount: Money;
  /** Liability account (Accounts Payable) credited when the bill is recorded. */
  apAccountId: string;
  /** Expense account debited when the bill is recorded. */
  expenseAccountId: string;
  /** Stable external id; makes recording the bill idempotent per org. */
  externalId?: string;
}

export interface CreatedBill {
  bill: Bill;
  posted: PostedEntry;
  /** Present when an approval rule requires sign-off before this bill is paid. */
  approval?: Approval;
}

/**
 * Record a vendor bill (accounts payable): posts Dr expense / Cr A/P through the
 * ledger posting service. Idempotent per (org, externalId): recording the same
 * bill twice returns the original and posts nothing new.
 */
export async function createBill(
  orgId: string,
  input: CreateBillInput,
  options: { actor?: string } = {},
): Promise<CreatedBill> {
  const amount = assertPositiveMoney(input.amount, "bill.amount");
  const actor = options.actor ?? "system";

  return db.transaction(async (tx) => {
    if (input.externalId) {
      const [existing] = await tx
        .select()
        .from(billsTable)
        .where(
          and(
            eq(billsTable.orgId, orgId),
            eq(billsTable.externalId, input.externalId),
          ),
        )
        .limit(1);
      if (existing) {
        if (!existing.postedEntryId) {
          throw new NotFoundError("Bill has no posted entry.");
        }
        const posted = await loadPostedEntry(orgId, existing.postedEntryId, tx);
        const approval = await getApproval(
          orgId,
          BILL_APPROVAL_ENTITY,
          existing.id,
          tx,
        );
        return { bill: existing, posted, approval };
      }
    }

    const [bill] = await tx
      .insert(billsTable)
      .values({
        orgId,
        vendor: input.vendor,
        billNumber: input.billNumber,
        billDate: input.billDate,
        dueDate: input.dueDate,
        amount,
        apAccountId: input.apAccountId,
        expenseAccountId: input.expenseAccountId,
        externalId: input.externalId,
        status: "open",
      })
      .returning();

    const posted = await postJournalEntry(
      orgId,
      {
        entryDate: input.billDate,
        memo: `Bill ${input.billNumber ?? bill.id} — ${input.vendor}`,
        source: "ap_bill",
        lines: [
          { accountId: input.expenseAccountId, debit: amount },
          { accountId: input.apAccountId, credit: amount },
        ],
      },
      { actor, idempotencyKey: `bill:${bill.id}`, tx },
    );

    const [updated] = await tx
      .update(billsTable)
      .set({ postedEntryId: posted.entry.id })
      .where(eq(billsTable.id, bill.id))
      .returning();

    // If an approval rule applies to a bill of this size, create a pending
    // approval atomically with the bill. payBill blocks until it is granted.
    const { approval } = await evaluateApproval(
      orgId,
      BILL_APPROVAL_ENTITY,
      bill.id,
      amount,
      { actor, tx },
    );

    return { bill: updated, posted, approval };
  });
}

export interface PayBillInput {
  billId: string;
  paymentDate: string; // YYYY-MM-DD
  amount: Money;
  /** Asset account (Cash/Bank) credited when the payment is made. */
  cashAccountId: string;
  externalId?: string;
}

export interface PaidBill {
  payment: BillPayment;
  bill: Bill;
  posted: PostedEntry;
}

/**
 * Pay (part of) a bill: posts Dr A/P / Cr cash. Idempotent per
 * (org, externalId). Marks the bill "paid" once payments cover its amount.
 */
export async function payBill(
  orgId: string,
  input: PayBillInput,
  options: { actor?: string } = {},
): Promise<PaidBill> {
  const amount = assertPositiveMoney(input.amount, "payment.amount");
  const actor = options.actor ?? "system";

  return db.transaction(async (tx) => {
    const [bill] = await tx
      .select()
      .from(billsTable)
      .where(and(eq(billsTable.orgId, orgId), eq(billsTable.id, input.billId)))
      .limit(1);
    if (!bill) {
      throw new NotFoundError(`Bill ${input.billId} not found for org.`);
    }

    // Block payment when a rule requires approval that has not been granted.
    // Passes silently when no rule applied to this bill.
    await requireApproved(orgId, BILL_APPROVAL_ENTITY, bill.id, tx);

    if (input.externalId) {
      const [existing] = await tx
        .select()
        .from(billPaymentsTable)
        .where(
          and(
            eq(billPaymentsTable.orgId, orgId),
            eq(billPaymentsTable.externalId, input.externalId),
          ),
        )
        .limit(1);
      if (existing) {
        if (!existing.postedEntryId) {
          throw new NotFoundError("Bill payment has no posted entry.");
        }
        const posted = await loadPostedEntry(orgId, existing.postedEntryId, tx);
        return { payment: existing, bill, posted };
      }
    }

    const [payment] = await tx
      .insert(billPaymentsTable)
      .values({
        orgId,
        billId: bill.id,
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
        memo: `Payment for bill ${bill.billNumber ?? bill.id}`,
        source: "ap_payment",
        lines: [
          { accountId: bill.apAccountId, debit: amount },
          { accountId: input.cashAccountId, credit: amount },
        ],
      },
      { actor, idempotencyKey: `billpay:${payment.id}`, tx },
    );

    const [linkedPayment] = await tx
      .update(billPaymentsTable)
      .set({ postedEntryId: posted.entry.id })
      .where(eq(billPaymentsTable.id, payment.id))
      .returning();

    const paidSoFar = await sumPayments(tx, orgId, bill.id);
    const [updatedBill] = await tx
      .update(billsTable)
      .set({ status: paidSoFar >= bill.amount ? "paid" : "open" })
      .where(eq(billsTable.id, bill.id))
      .returning();

    return { payment: linkedPayment, bill: updatedBill, posted };
  });
}

async function sumPayments(
  tx: LedgerTx,
  orgId: string,
  billId: string,
): Promise<Money> {
  const [row] = await tx
    .select({
      total: sql<string>`COALESCE(SUM(${billPaymentsTable.amount}), 0)`,
    })
    .from(billPaymentsTable)
    .where(
      and(
        eq(billPaymentsTable.orgId, orgId),
        eq(billPaymentsTable.billId, billId),
      ),
    );
  return BigInt(row?.total ?? "0");
}
