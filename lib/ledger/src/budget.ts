import { and, eq, gte, lte, sql } from "drizzle-orm";
import {
  db,
  budgetsTable,
  budgetLinesTable,
  accountsTable,
  journalLinesTable,
  journalEntriesTable,
  auditLogTable,
  type Budget,
  type BudgetLine,
  type AccountType,
  type NormalBalance,
} from "@workspace/db";
import { assertPositiveMoney, naturalBalance, type Money } from "./money";
import { NotFoundError } from "./errors";
import { serializeForAudit } from "./audit";

/** Create a budget covering a period window. Audit-logged. */
export async function createBudget(
  orgId: string,
  input: { name: string; periodStart: string; periodEnd: string },
  options: { actor?: string } = {},
): Promise<Budget> {
  const actor = options.actor ?? "system";
  return db.transaction(async (tx) => {
    const [budget] = await tx
      .insert(budgetsTable)
      .values({
        orgId,
        name: input.name,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
      })
      .returning();

    await tx.insert(auditLogTable).values({
      orgId,
      actor,
      action: "budget.create",
      entity: "budget",
      entityId: budget.id,
      before: null,
      after: serializeForAudit(budget),
    });

    return budget;
  });
}

/**
 * Set (or update) the planned amount for an account within a budget. Idempotent
 * per (org, budget, account): calling again overwrites the planned figure.
 */
export async function setBudgetLine(
  orgId: string,
  budgetId: string,
  accountId: string,
  amount: Money,
  options: { actor?: string } = {},
): Promise<BudgetLine> {
  const value = assertPositiveMoney(amount, "budget.amount");
  const actor = options.actor ?? "system";
  return db.transaction(async (tx) => {
    const [budget] = await tx
      .select()
      .from(budgetsTable)
      .where(
        and(eq(budgetsTable.orgId, orgId), eq(budgetsTable.id, budgetId)),
      )
      .limit(1);
    if (!budget) throw new NotFoundError(`Budget ${budgetId} not found for org.`);

    const [line] = await tx
      .insert(budgetLinesTable)
      .values({ orgId, budgetId, accountId, amount: value })
      .onConflictDoUpdate({
        target: [
          budgetLinesTable.orgId,
          budgetLinesTable.budgetId,
          budgetLinesTable.accountId,
        ],
        set: { amount: value },
      })
      .returning();

    await tx.insert(auditLogTable).values({
      orgId,
      actor,
      action: "budget.set_line",
      entity: "budget_line",
      entityId: line.id,
      before: null,
      after: serializeForAudit(line),
    });

    return line;
  });
}

export interface BudgetVsActualRow {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  budgeted: Money;
  actual: Money;
  /** actual − budgeted (positive = over the planned figure). */
  variance: Money;
}

export interface BudgetVsActual {
  budget: Budget;
  rows: BudgetVsActualRow[];
  totalBudgeted: Money;
  totalActual: Money;
  totalVariance: Money;
}

/**
 * Compare a budget's planned figures against actuals derived from the ledger.
 * Actuals are the natural balance of each budgeted account over the budget's
 * period window (posted journal lines only) — never a stored figure.
 */
export async function getBudgetVsActual(
  orgId: string,
  budgetId: string,
): Promise<BudgetVsActual> {
  const [budget] = await db
    .select()
    .from(budgetsTable)
    .where(and(eq(budgetsTable.orgId, orgId), eq(budgetsTable.id, budgetId)))
    .limit(1);
  if (!budget) throw new NotFoundError(`Budget ${budgetId} not found for org.`);

  const lines = await db
    .select({
      accountId: budgetLinesTable.accountId,
      code: accountsTable.code,
      name: accountsTable.name,
      type: accountsTable.type,
      normalBalance: accountsTable.normalBalance,
      budgeted: budgetLinesTable.amount,
    })
    .from(budgetLinesTable)
    .innerJoin(
      accountsTable,
      and(
        eq(budgetLinesTable.orgId, accountsTable.orgId),
        eq(budgetLinesTable.accountId, accountsTable.id),
      ),
    )
    .where(
      and(
        eq(budgetLinesTable.orgId, orgId),
        eq(budgetLinesTable.budgetId, budgetId),
      ),
    )
    .orderBy(accountsTable.code);

  // Actuals per account over the window, natural balance from the ledger.
  const actuals = await db
    .select({
      accountId: journalLinesTable.accountId,
      normalBalance: accountsTable.normalBalance,
      debit: sql<string>`COALESCE(SUM(${journalLinesTable.debit}), 0)`,
      credit: sql<string>`COALESCE(SUM(${journalLinesTable.credit}), 0)`,
    })
    .from(journalLinesTable)
    .innerJoin(
      accountsTable,
      and(
        eq(journalLinesTable.orgId, accountsTable.orgId),
        eq(journalLinesTable.accountId, accountsTable.id),
      ),
    )
    .innerJoin(
      journalEntriesTable,
      and(
        eq(journalLinesTable.orgId, journalEntriesTable.orgId),
        eq(journalLinesTable.entryId, journalEntriesTable.id),
      ),
    )
    .where(
      and(
        eq(journalLinesTable.orgId, orgId),
        gte(journalEntriesTable.entryDate, budget.periodStart),
        lte(journalEntriesTable.entryDate, budget.periodEnd),
      ),
    )
    .groupBy(journalLinesTable.accountId, accountsTable.normalBalance);

  const actualByAccount = new Map<string, Money>();
  for (const a of actuals) {
    actualByAccount.set(
      a.accountId,
      naturalBalance(
        a.normalBalance as NormalBalance,
        BigInt(a.debit) - BigInt(a.credit),
      ),
    );
  }

  const rows: BudgetVsActualRow[] = [];
  let totalBudgeted = 0n;
  let totalActual = 0n;
  for (const l of lines) {
    const budgeted = l.budgeted;
    const actual = actualByAccount.get(l.accountId) ?? 0n;
    rows.push({
      accountId: l.accountId,
      code: l.code,
      name: l.name,
      type: l.type,
      budgeted,
      actual,
      variance: actual - budgeted,
    });
    totalBudgeted += budgeted;
    totalActual += actual;
  }

  return {
    budget,
    rows,
    totalBudgeted,
    totalActual,
    totalVariance: totalActual - totalBudgeted,
  };
}
