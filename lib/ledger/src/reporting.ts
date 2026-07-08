import { and, eq, sql } from "drizzle-orm";
import {
  db,
  accountsTable,
  journalLinesTable,
  type AccountType,
  type NormalBalance,
} from "@workspace/db";
import { naturalBalance, type Money } from "./money";

const zero = sql<string>`0`;

/** Balance of a single account, scoped to org. */
export interface AccountBalance {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  normalBalance: NormalBalance;
  debit: Money;
  credit: Money;
  /** debit - credit (raw). */
  debitMinusCredit: Money;
  /** Natural balance (positive when the account carries its expected side). */
  balance: Money;
}

export async function getAccountBalance(
  orgId: string,
  accountId: string,
): Promise<AccountBalance> {
  const [row] = await db
    .select({
      id: accountsTable.id,
      code: accountsTable.code,
      name: accountsTable.name,
      type: accountsTable.type,
      normalBalance: accountsTable.normalBalance,
      debit: sql<string>`COALESCE(SUM(${journalLinesTable.debit}), ${zero})`,
      credit: sql<string>`COALESCE(SUM(${journalLinesTable.credit}), ${zero})`,
    })
    .from(accountsTable)
    .leftJoin(
      journalLinesTable,
      and(
        eq(journalLinesTable.accountId, accountsTable.id),
        eq(journalLinesTable.orgId, accountsTable.orgId),
      ),
    )
    .where(and(eq(accountsTable.orgId, orgId), eq(accountsTable.id, accountId)))
    .groupBy(accountsTable.id);

  if (!row) {
    throw new Error(`Account ${accountId} not found for org.`);
  }

  const debit = BigInt(row.debit);
  const credit = BigInt(row.credit);
  const debitMinusCredit = debit - credit;

  return {
    accountId: row.id,
    code: row.code,
    name: row.name,
    type: row.type,
    normalBalance: row.normalBalance,
    debit,
    credit,
    debitMinusCredit,
    balance: naturalBalance(row.normalBalance, debitMinusCredit),
  };
}

export interface TrialBalance {
  rows: AccountBalance[];
  totalDebit: Money;
  totalCredit: Money;
  /** Sum of (debit - credit) across all accounts; always 0 for a valid ledger. */
  difference: Money;
}

/** Trial balance: one row per account with debit/credit totals. */
export async function getTrialBalance(orgId: string): Promise<TrialBalance> {
  const rawRows = await db
    .select({
      id: accountsTable.id,
      code: accountsTable.code,
      name: accountsTable.name,
      type: accountsTable.type,
      normalBalance: accountsTable.normalBalance,
      debit: sql<string>`COALESCE(SUM(${journalLinesTable.debit}), ${zero})`,
      credit: sql<string>`COALESCE(SUM(${journalLinesTable.credit}), ${zero})`,
    })
    .from(accountsTable)
    .leftJoin(
      journalLinesTable,
      and(
        eq(journalLinesTable.accountId, accountsTable.id),
        eq(journalLinesTable.orgId, accountsTable.orgId),
      ),
    )
    .where(eq(accountsTable.orgId, orgId))
    .groupBy(accountsTable.id)
    .orderBy(accountsTable.code);

  let totalDebit = 0n;
  let totalCredit = 0n;
  const rows: AccountBalance[] = rawRows.map((row) => {
    const debit = BigInt(row.debit);
    const credit = BigInt(row.credit);
    totalDebit += debit;
    totalCredit += credit;
    const debitMinusCredit = debit - credit;
    return {
      accountId: row.id,
      code: row.code,
      name: row.name,
      type: row.type,
      normalBalance: row.normalBalance,
      debit,
      credit,
      debitMinusCredit,
      balance: naturalBalance(row.normalBalance, debitMinusCredit),
    };
  });

  return {
    rows,
    totalDebit,
    totalCredit,
    difference: totalDebit - totalCredit,
  };
}

/** Aggregate the natural balance of all accounts of a given type. */
async function sumByType(orgId: string, type: AccountType): Promise<Money> {
  const trial = await getTrialBalance(orgId);
  return trial.rows
    .filter((r) => r.type === type)
    .reduce((acc, r) => acc + r.balance, 0n);
}

export interface ProfitAndLoss {
  revenue: Money;
  expenses: Money;
  netIncome: Money;
}

/** Profit & loss: revenue minus expenses over all posted entries. */
export async function getProfitAndLoss(orgId: string): Promise<ProfitAndLoss> {
  const trial = await getTrialBalance(orgId);
  let revenue = 0n;
  let expenses = 0n;
  for (const r of trial.rows) {
    if (r.type === "revenue") revenue += r.balance;
    if (r.type === "expense") expenses += r.balance;
  }
  return { revenue, expenses, netIncome: revenue - expenses };
}

export interface BalanceSheet {
  assets: Money;
  liabilities: Money;
  /** Equity from equity accounts only. */
  equity: Money;
  /** Current-period net income (revenue - expenses). */
  netIncome: Money;
  /** Equity including retained earnings / current net income. */
  equityWithIncome: Money;
  /** True when assets == liabilities + equityWithIncome. */
  balances: boolean;
}

/**
 * Balance sheet. The accounting equation only closes when current-period net
 * income is folded into equity, so `equityWithIncome` includes it.
 */
export async function getBalanceSheet(orgId: string): Promise<BalanceSheet> {
  const trial = await getTrialBalance(orgId);
  let assets = 0n;
  let liabilities = 0n;
  let equity = 0n;
  let revenue = 0n;
  let expenses = 0n;
  for (const r of trial.rows) {
    switch (r.type) {
      case "asset":
        assets += r.balance;
        break;
      case "liability":
        liabilities += r.balance;
        break;
      case "equity":
        equity += r.balance;
        break;
      case "revenue":
        revenue += r.balance;
        break;
      case "expense":
        expenses += r.balance;
        break;
    }
  }
  const netIncome = revenue - expenses;
  const equityWithIncome = equity + netIncome;
  return {
    assets,
    liabilities,
    equity,
    netIncome,
    equityWithIncome,
    balances: assets === liabilities + equityWithIncome,
  };
}

export { sumByType };
