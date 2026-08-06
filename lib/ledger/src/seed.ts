import {
  db,
  organizationsTable,
  accountsTable,
  auditLogTable,
  type Account,
  type Organization,
} from "@workspace/db";
import { normalBalanceFor } from "./money";
import type { AccountType } from "@workspace/db";

interface StarterAccount {
  code: string;
  name: string;
  type: AccountType;
}

/**
 * A conventional general-purpose small-business chart of accounts, following
 * standard numbering: 1000s assets, 2000s liabilities, 3000s equity,
 * 4000s revenue, 5000s COGS, 6000s operating expenses.
 *
 * 1900/2900 (intercompany) are not part of the standard small-business chart
 * but are kept because the consolidation feature posts against them.
 */
export const STARTER_CHART_OF_ACCOUNTS: StarterAccount[] = [
  // Assets (1000s)
  { code: "1000", name: "Cash", type: "asset" },
  { code: "1010", name: "Checking", type: "asset" },
  { code: "1020", name: "Savings", type: "asset" },
  { code: "1100", name: "Accounts Receivable", type: "asset" },
  { code: "1200", name: "Undeposited Funds", type: "asset" },
  { code: "1500", name: "Fixed Assets / Equipment", type: "asset" },
  { code: "1900", name: "Intercompany Receivable", type: "asset" },
  // Liabilities (2000s)
  { code: "2000", name: "Accounts Payable", type: "liability" },
  { code: "2100", name: "Credit Card Payable", type: "liability" },
  { code: "2200", name: "Sales Tax Payable", type: "liability" },
  { code: "2300", name: "Payroll Liabilities", type: "liability" },
  { code: "2500", name: "Loans Payable", type: "liability" },
  { code: "2900", name: "Intercompany Payable", type: "liability" },
  // Equity (3000s)
  { code: "3000", name: "Owner's Equity / Opening Balance Equity", type: "equity" },
  { code: "3100", name: "Owner's Contributions", type: "equity" },
  { code: "3200", name: "Owner's Draw", type: "equity" },
  { code: "3900", name: "Retained Earnings", type: "equity" },
  // Revenue (4000s)
  { code: "4000", name: "Sales Revenue", type: "revenue" },
  { code: "4100", name: "Service Revenue", type: "revenue" },
  { code: "4900", name: "Other Income", type: "revenue" },
  // Expenses (5000s COGS, 6000s operating)
  { code: "5000", name: "Cost of Goods Sold", type: "expense" },
  { code: "6000", name: "Advertising & Marketing", type: "expense" },
  { code: "6050", name: "Bank & Merchant Fees", type: "expense" },
  { code: "6100", name: "Dues & Subscriptions", type: "expense" },
  { code: "6150", name: "Insurance", type: "expense" },
  { code: "6200", name: "Meals & Entertainment", type: "expense" },
  { code: "6250", name: "Office Supplies", type: "expense" },
  { code: "6300", name: "Payroll / Wages", type: "expense" },
  { code: "6350", name: "Professional Fees (Legal, Accounting)", type: "expense" },
  { code: "6400", name: "Rent & Lease", type: "expense" },
  { code: "6450", name: "Repairs & Maintenance", type: "expense" },
  { code: "6500", name: "Software & Technology", type: "expense" },
  { code: "6550", name: "Travel", type: "expense" },
  { code: "6600", name: "Utilities", type: "expense" },
  { code: "6900", name: "Other / Miscellaneous Expense", type: "expense" },
];

export interface SeededOrg {
  organization: Organization;
  accounts: Account[];
  /** Convenience lookup of account by its code. */
  byCode: Record<string, Account>;
}

/**
 * Idempotently add any STARTER_CHART_OF_ACCOUNTS entries an EXISTING org is
 * missing, matched by CODE. Accounts the org already has — including custom
 * ones that happen to use a default code (e.g. a user-created 1010) — are
 * left completely untouched: the (orgId, code) unique + onConflictDoNothing
 * makes re-runs no-ops. Chart-of-accounts data only; never touches entries.
 */
export async function seedMissingDefaultAccounts(
  orgId: string,
  actor = "system",
): Promise<Account[]> {
  return db.transaction(async (tx) => {
    const added = await tx
      .insert(accountsTable)
      .values(
        STARTER_CHART_OF_ACCOUNTS.map((a) => ({
          orgId,
          code: a.code,
          name: a.name,
          type: a.type,
          normalBalance: normalBalanceFor(a.type),
        })),
      )
      .onConflictDoNothing({
        target: [accountsTable.orgId, accountsTable.code],
      })
      .returning();

    if (added.length > 0) {
      await tx.insert(auditLogTable).values({
        orgId,
        actor,
        action: "seed_missing_defaults",
        entity: "organization",
        entityId: orgId,
        before: null,
        after: { addedCodes: added.map((a) => a.code) },
      });
    }
    return added;
  });
}

/** Create an organization with the standard starter chart of accounts. */
export async function seedOrganization(
  name: string,
  actor = "system",
  options: { baseCurrency?: string } = {},
): Promise<SeededOrg> {
  return db.transaction(async (tx) => {
    const [organization] = await tx
      .insert(organizationsTable)
      .values({ name, baseCurrency: options.baseCurrency ?? "USD" })
      .returning();

    const accounts = await tx
      .insert(accountsTable)
      .values(
        STARTER_CHART_OF_ACCOUNTS.map((a) => ({
          orgId: organization.id,
          code: a.code,
          name: a.name,
          type: a.type,
          normalBalance: normalBalanceFor(a.type),
        })),
      )
      .returning();

    await tx.insert(auditLogTable).values({
      orgId: organization.id,
      actor,
      action: "seed",
      entity: "organization",
      entityId: organization.id,
      before: null,
      after: { name, accountCount: accounts.length },
    });

    const byCode: Record<string, Account> = {};
    for (const a of accounts) byCode[a.code] = a;

    return { organization, accounts, byCode };
  });
}
