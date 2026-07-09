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

/** A conventional small-business starter chart of accounts. */
export const STARTER_CHART_OF_ACCOUNTS: StarterAccount[] = [
  { code: "1000", name: "Cash", type: "asset" },
  { code: "1100", name: "Accounts Receivable", type: "asset" },
  { code: "1200", name: "Inventory", type: "asset" },
  { code: "1500", name: "Equipment", type: "asset" },
  { code: "1900", name: "Intercompany Receivable", type: "asset" },
  { code: "2000", name: "Accounts Payable", type: "liability" },
  { code: "2900", name: "Intercompany Payable", type: "liability" },
  { code: "2100", name: "Loans Payable", type: "liability" },
  { code: "2200", name: "Sales Tax Payable", type: "liability" },
  { code: "3000", name: "Owner's Equity", type: "equity" },
  { code: "3100", name: "Retained Earnings", type: "equity" },
  { code: "4000", name: "Sales Revenue", type: "revenue" },
  { code: "4100", name: "Service Revenue", type: "revenue" },
  { code: "5000", name: "Cost of Goods Sold", type: "expense" },
  { code: "5100", name: "Rent Expense", type: "expense" },
  { code: "5200", name: "Salaries Expense", type: "expense" },
  { code: "5300", name: "Utilities Expense", type: "expense" },
  { code: "5400", name: "Meals & Entertainment", type: "expense" },
  { code: "5500", name: "Travel", type: "expense" },
  { code: "5600", name: "Software & Subscriptions", type: "expense" },
  { code: "5700", name: "Bank Fees & Charges", type: "expense" },
];

export interface SeededOrg {
  organization: Organization;
  accounts: Account[];
  /** Convenience lookup of account by its code. */
  byCode: Record<string, Account>;
}

/** Create an organization with the standard starter chart of accounts. */
export async function seedOrganization(
  name: string,
  actor = "system",
): Promise<SeededOrg> {
  return db.transaction(async (tx) => {
    const [organization] = await tx
      .insert(organizationsTable)
      .values({ name })
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
