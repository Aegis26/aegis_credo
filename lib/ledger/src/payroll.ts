import { and, eq } from "drizzle-orm";
import { db, payrollRunsTable, type PayrollRun } from "@workspace/db";
import {
  assertNonNegativeMoney,
  assertPositiveMoney,
  type Money,
} from "./money";
import { ImportError, NotFoundError } from "./errors";
import {
  postJournalEntry,
  loadPostedEntry,
  type PostedEntry,
} from "./posting";

/** Supported payroll providers. We ingest their output only — no tax logic. */
export type PayrollProvider = "gusto" | "check";

export interface PostPayrollRunInput {
  provider: PayrollProvider; // "gusto" | "check"
  /** Provider's own run id — the idempotency anchor for this run. */
  externalId: string;
  payDate: string; // YYYY-MM-DD
  /** Provider-computed totals, in integer minor units. No tax logic here. */
  grossPay: Money;
  taxes: Money;
  netPay: Money;
  /** Expense account debited for gross wages. */
  salariesExpenseAccountId: string;
  /** Asset account (Cash/Bank) credited for net pay. */
  cashAccountId: string;
  /** Liability account credited for withheld/employer taxes. */
  taxLiabilityAccountId: string;
}

export interface PostedPayrollRun {
  run: PayrollRun;
  posted: PostedEntry;
}

/**
 * Ingest a provider's finished payroll run (Gusto / Check) as a journal entry.
 * We record the provider's numbers verbatim — no tax computation — and only
 * enforce the accounting identity gross = net + taxes so the entry balances:
 *   Dr Salaries Expense (gross)
 *     Cr Cash (net)
 *     Cr Payroll Tax Liabilities (taxes)
 * Idempotent per (org, provider, externalId).
 */
export async function postPayrollRun(
  orgId: string,
  input: PostPayrollRunInput,
  options: { actor?: string } = {},
): Promise<PostedPayrollRun> {
  const gross = assertPositiveMoney(input.grossPay, "payroll.grossPay");
  const taxes = assertNonNegativeMoney(input.taxes, "payroll.taxes");
  const net = assertPositiveMoney(input.netPay, "payroll.netPay");
  const actor = options.actor ?? "system";

  if (gross !== net + taxes) {
    throw new ImportError(
      `Payroll run does not balance: gross ${gross} != net ${net} + taxes ${taxes}.`,
    );
  }

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(payrollRunsTable)
      .where(
        and(
          eq(payrollRunsTable.orgId, orgId),
          eq(payrollRunsTable.provider, input.provider),
          eq(payrollRunsTable.externalId, input.externalId),
        ),
      )
      .limit(1);
    if (existing) {
      if (!existing.postedEntryId) {
        throw new NotFoundError("Payroll run has no posted entry.");
      }
      const posted = await loadPostedEntry(orgId, existing.postedEntryId, tx);
      return { run: existing, posted };
    }

    const [run] = await tx
      .insert(payrollRunsTable)
      .values({
        orgId,
        provider: input.provider,
        externalId: input.externalId,
        payDate: input.payDate,
        grossPay: gross,
        taxes,
        netPay: net,
      })
      .returning();

    const lines = [
      { accountId: input.salariesExpenseAccountId, debit: gross },
      { accountId: input.cashAccountId, credit: net },
    ];
    if (taxes > 0n) {
      lines.push({ accountId: input.taxLiabilityAccountId, credit: taxes });
    }

    const posted = await postJournalEntry(
      orgId,
      {
        entryDate: input.payDate,
        memo: `Payroll ${input.provider} run ${input.externalId}`,
        source: "payroll",
        lines,
      },
      {
        actor,
        idempotencyKey: `payroll:${input.provider}:${input.externalId}`,
        tx,
      },
    );

    const [updated] = await tx
      .update(payrollRunsTable)
      .set({ postedEntryId: posted.entry.id })
      .where(eq(payrollRunsTable.id, run.id))
      .returning();

    return { run: updated, posted };
  });
}
