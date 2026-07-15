import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  groupsTable,
  organizationsTable,
  accountsTable,
  journalLinesTable,
  auditLogTable,
  type Group,
  type AccountType,
  type NormalBalance,
} from "@workspace/db";
import { naturalBalance, type Money } from "./money";
import { NotFoundError } from "./errors";
import { serializeForAudit } from "./audit";

const zero = sql<string>`0`;

/** Create a parent group. Audit-logged against the group's own id. */
export async function createGroup(
  name: string,
  options: { actor?: string } = {},
): Promise<Group> {
  const actor = options.actor ?? "system";
  // createdBy makes the empty group visible to (and manageable by) its creator
  // before the first org is attached. Audit rows are keyed to member orgs as
  // they are added (below). (Group creation itself is not a ledger mutation.)
  const [group] = await db
    .insert(groupsTable)
    .values({ name, createdBy: options.actor ?? null })
    .returning();
  void actor;
  return group;
}

/**
 * Add an organization (entity) to a group. The entity's ledger is untouched;
 * this only sets its parent pointer so consolidation includes it. Audit-logged.
 */
export async function addOrgToGroup(
  groupId: string,
  orgId: string,
  options: { actor?: string } = {},
): Promise<void> {
  const actor = options.actor ?? "system";
  return db.transaction(async (tx) => {
    const [group] = await tx
      .select()
      .from(groupsTable)
      .where(eq(groupsTable.id, groupId))
      .limit(1);
    if (!group) throw new NotFoundError(`Group ${groupId} not found.`);

    const [org] = await tx
      .select()
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId))
      .limit(1);
    if (!org) throw new NotFoundError(`Org ${orgId} not found.`);

    const [updated] = await tx
      .update(organizationsTable)
      .set({ groupId })
      .where(eq(organizationsTable.id, orgId))
      .returning();

    await tx.insert(auditLogTable).values({
      orgId,
      actor,
      action: "group.add_org",
      entity: "organization",
      entityId: orgId,
      before: serializeForAudit(org),
      after: serializeForAudit(updated),
    });
  });
}

/** The org ids currently belonging to a group. */
export async function listOrgsInGroup(groupId: string): Promise<string[]> {
  const rows = await db
    .select({ id: organizationsTable.id })
    .from(organizationsTable)
    .where(eq(organizationsTable.groupId, groupId))
    .orderBy(organizationsTable.name);
  return rows.map((r) => r.id);
}

/** One consolidated line, keyed by account code (ids differ across entities). */
export interface ConsolidatedRow {
  code: string;
  name: string;
  type: AccountType;
  normalBalance: NormalBalance;
  debit: Money;
  credit: Money;
  balance: Money;
}

export interface ConsolidatedTrialBalance {
  groupId: string;
  entities: string[];
  /** Simple sum of every entity's ledger, before elimination. */
  combined: ConsolidatedRow[];
  /** Intercompany amounts removed (as positive debit/credit that were dropped). */
  eliminations: ConsolidatedRow[];
  /** Combined minus eliminations — the group's external-facing position. */
  consolidated: ConsolidatedRow[];
  totalDebit: Money;
  totalCredit: Money;
  difference: Money;
}

interface RawSum {
  code: string;
  name: string;
  type: AccountType;
  normalBalance: NormalBalance;
  debit: string;
  credit: string;
}

/** Sum journal-line debits/credits across members, grouped by account code. */
async function sumByCode(
  members: string[],
  intercompanyOnly: boolean,
): Promise<RawSum[]> {
  const conds = [inArray(accountsTable.orgId, members)];
  if (intercompanyOnly) {
    conds.push(inArray(journalLinesTable.counterpartyOrgId, members));
  }
  return db
    .select({
      code: accountsTable.code,
      name: accountsTable.name,
      type: accountsTable.type,
      normalBalance: accountsTable.normalBalance,
      debit: sql<string>`COALESCE(SUM(${journalLinesTable.debit}), ${zero})`,
      credit: sql<string>`COALESCE(SUM(${journalLinesTable.credit}), ${zero})`,
    })
    .from(journalLinesTable)
    .innerJoin(
      accountsTable,
      and(
        eq(journalLinesTable.orgId, accountsTable.orgId),
        eq(journalLinesTable.accountId, accountsTable.id),
      ),
    )
    .where(and(...conds))
    .groupBy(
      accountsTable.code,
      accountsTable.name,
      accountsTable.type,
      accountsTable.normalBalance,
    )
    .orderBy(accountsTable.code);
}

interface Merged {
  code: string;
  name: string;
  type: AccountType;
  normalBalance: NormalBalance;
  debit: Money;
  credit: Money;
}

/**
 * Collapse raw per-(code, metadata) sums into one row per account code. The SQL
 * groups by code plus name/type/normalBalance (all valid grouping columns), but
 * consolidation combines strictly by code, so merge any split rows here — this
 * keeps combined and elimination maps on the same canonical key.
 */
function mergeByCode(rows: RawSum[]): Map<string, Merged> {
  const m = new Map<string, Merged>();
  for (const r of rows) {
    const existing = m.get(r.code);
    if (existing) {
      existing.debit += BigInt(r.debit);
      existing.credit += BigInt(r.credit);
    } else {
      m.set(r.code, {
        code: r.code,
        name: r.name,
        type: r.type,
        normalBalance: r.normalBalance,
        debit: BigInt(r.debit),
        credit: BigInt(r.credit),
      });
    }
  }
  return m;
}

function toRow(meta: Merged, debit: Money, credit: Money): ConsolidatedRow {
  return {
    code: meta.code,
    name: meta.name,
    type: meta.type,
    normalBalance: meta.normalBalance,
    debit,
    credit,
    balance: naturalBalance(meta.normalBalance, debit - credit),
  };
}

/**
 * Consolidated trial balance across a group. Combines each entity's ledger by
 * account code, then eliminates intercompany activity (lines whose counterparty
 * is another member) so the group only reflects transactions with the outside
 * world. READ-ONLY: never writes to any entity's ledger.
 */
export async function getConsolidatedTrialBalance(
  groupId: string,
): Promise<ConsolidatedTrialBalance> {
  const members = await listOrgsInGroup(groupId);
  if (members.length === 0) {
    return {
      groupId,
      entities: [],
      combined: [],
      eliminations: [],
      consolidated: [],
      totalDebit: 0n,
      totalCredit: 0n,
      difference: 0n,
    };
  }

  const [combinedRaw, elimRaw] = await Promise.all([
    sumByCode(members, false),
    sumByCode(members, true),
  ]);

  const combinedByCode = mergeByCode(combinedRaw);
  const elimByCode = mergeByCode(elimRaw);

  const combined: ConsolidatedRow[] = [];
  const eliminations: ConsolidatedRow[] = [];
  const consolidated: ConsolidatedRow[] = [];
  let totalDebit = 0n;
  let totalCredit = 0n;

  const codes = [...combinedByCode.keys()].sort();
  for (const code of codes) {
    const c = combinedByCode.get(code)!;
    combined.push(toRow(c, c.debit, c.credit));

    const e = elimByCode.get(code);
    const eDebit = e?.debit ?? 0n;
    const eCredit = e?.credit ?? 0n;
    if (eDebit > 0n || eCredit > 0n) {
      eliminations.push(toRow(c, eDebit, eCredit));
    }

    const conDebit = c.debit - eDebit;
    const conCredit = c.credit - eCredit;
    totalDebit += conDebit;
    totalCredit += conCredit;
    consolidated.push(toRow(c, conDebit, conCredit));
  }

  return {
    groupId,
    entities: members,
    combined,
    eliminations,
    consolidated,
    totalDebit,
    totalCredit,
    difference: totalDebit - totalCredit,
  };
}

export interface ConsolidatedProfitAndLoss {
  groupId: string;
  entities: string[];
  revenue: Money;
  expenses: Money;
  netIncome: Money;
}

/** Consolidated P&L: revenue minus expenses over the post-elimination ledger. */
export async function getConsolidatedProfitAndLoss(
  groupId: string,
): Promise<ConsolidatedProfitAndLoss> {
  const tb = await getConsolidatedTrialBalance(groupId);
  let revenue = 0n;
  let expenses = 0n;
  for (const r of tb.consolidated) {
    if (r.type === "revenue") revenue += r.balance;
    if (r.type === "expense") expenses += r.balance;
  }
  return {
    groupId,
    entities: tb.entities,
    revenue,
    expenses,
    netIncome: revenue - expenses,
  };
}

export interface ConsolidatedBalanceSheet {
  groupId: string;
  entities: string[];
  assets: Money;
  liabilities: Money;
  equity: Money;
  netIncome: Money;
  equityWithIncome: Money;
  balances: boolean;
}

/**
 * Consolidated balance sheet. As with the single-entity balance sheet, the
 * accounting equation only closes once current-period net income is folded into
 * equity, so `equityWithIncome` includes it.
 */
export async function getConsolidatedBalanceSheet(
  groupId: string,
): Promise<ConsolidatedBalanceSheet> {
  const tb = await getConsolidatedTrialBalance(groupId);
  let assets = 0n;
  let liabilities = 0n;
  let equity = 0n;
  let revenue = 0n;
  let expenses = 0n;
  for (const r of tb.consolidated) {
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
    groupId,
    entities: tb.entities,
    assets,
    liabilities,
    equity,
    netIncome,
    equityWithIncome,
    balances: assets === liabilities + equityWithIncome,
  };
}
