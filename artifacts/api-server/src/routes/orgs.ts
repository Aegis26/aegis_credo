import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  organizationsTable,
  accountsTable,
  journalEntriesTable,
  journalLinesTable,
  type Account,
} from "@workspace/db";
import {
  ListMyOrgsResponse,
  CreateOrgBody,
  CreateOrgResponse,
  ListAccountsParams,
  ListAccountsResponse,
  GetOrgDashboardParams,
  GetOrgDashboardResponse,
} from "@workspace/api-zod";
import {
  seedOrganization,
  addMember,
  listOrgsForUser,
  getActiveMembership,
  requirePermission,
  getTrialBalance,
  formatMoney,
} from "@workspace/ledger";
import { sendLedgerError, HttpError } from "../lib/errors";
import { getSessionUserId } from "../middlewares/auth";

const router: IRouter = Router();

/** Load an org-scoped account by its chart code, or fail with a clear 400. */
async function accountByCode(orgId: string, code: string): Promise<Account> {
  const [account] = await db
    .select()
    .from(accountsTable)
    .where(and(eq(accountsTable.orgId, orgId), eq(accountsTable.code, code)))
    .limit(1);
  if (!account) {
    throw new HttpError(400, `Account ${code} does not exist for this org.`);
  }
  return account;
}

export { accountByCode };

router.get("/orgs", async (req, res) => {
  try {
    const userId = getSessionUserId(req);
    const orgIds = await listOrgsForUser(userId);
    if (orgIds.length === 0) {
      res.json(ListMyOrgsResponse.parse({ orgs: [] }));
      return;
    }
    const rows = await db
      .select({ id: organizationsTable.id, name: organizationsTable.name })
      .from(organizationsTable)
      .where(inArray(organizationsTable.id, orgIds));
    const orgs = await Promise.all(
      rows.map(async (o) => {
        const membership = await getActiveMembership(o.id, userId);
        return { id: o.id, name: o.name, role: membership?.role ?? null };
      }),
    );
    res.json(ListMyOrgsResponse.parse({ orgs }));
  } catch (err) {
    sendLedgerError(res, err);
  }
});

router.post("/orgs", async (req, res) => {
  try {
    const userId = getSessionUserId(req);
    const { name } = CreateOrgBody.parse(req.body);
    const { organization } = await seedOrganization(name, userId);
    await addMember(organization.id, userId, "owner", { actor: userId });
    res
      .status(201)
      .json(
        CreateOrgResponse.parse({
          id: organization.id,
          name: organization.name,
          role: "owner",
        }),
      );
  } catch (err) {
    sendLedgerError(res, err);
  }
});

router.get("/orgs/:orgId/accounts", async (req, res) => {
  try {
    const userId = getSessionUserId(req);
    const { orgId } = ListAccountsParams.parse(req.params);
    await requirePermission(orgId, userId, "reports.read");
    const accounts = await db
      .select()
      .from(accountsTable)
      .where(eq(accountsTable.orgId, orgId))
      .orderBy(accountsTable.code);
    res.json(
      ListAccountsResponse.parse({
        accounts: accounts.map((a) => ({
          id: a.id,
          code: a.code,
          name: a.name,
          type: a.type,
          normalBalance: a.normalBalance,
        })),
      }),
    );
  } catch (err) {
    sendLedgerError(res, err);
  }
});

router.get("/orgs/:orgId/dashboard", async (req, res) => {
  try {
    const userId = getSessionUserId(req);
    const { orgId } = GetOrgDashboardParams.parse(req.params);
    await requirePermission(orgId, userId, "reports.read");

    const trial = await getTrialBalance(orgId);
    let cash = 0n;
    let revenue = 0n;
    let expenses = 0n;
    for (const row of trial.rows) {
      if (row.code === "1000") cash = row.balance;
      if (row.type === "revenue") revenue += row.balance;
      if (row.type === "expense") expenses += row.balance;
    }
    const netIncome = revenue - expenses;

    // Recent ledger activity. The representative amount is the entry's SIGNED
    // impact on cash (cash debits − cash credits) when the entry touches cash —
    // so money out reads as a negative outflow and money in as a positive inflow
    // instead of every entry showing an always-positive total debit. Entries
    // that don't touch cash (e.g. an invoice) fall back to the total debit.
    const entries = await db
      .select({
        id: journalEntriesTable.id,
        entryDate: journalEntriesTable.entryDate,
        memo: journalEntriesTable.memo,
        source: journalEntriesTable.source,
      })
      .from(journalEntriesTable)
      .where(eq(journalEntriesTable.orgId, orgId))
      .orderBy(desc(journalEntriesTable.postedAt))
      .limit(8);

    const activity = new Map<string, bigint>();
    if (entries.length > 0) {
      const ids = entries.map((e) => e.id);
      const sums = await db
        .select({
          entryId: journalLinesTable.entryId,
          totalDebit: sql<string>`COALESCE(SUM(${journalLinesTable.debit}), 0)`,
          cashNet: sql<string>`COALESCE(SUM(CASE WHEN ${accountsTable.code} = '1000' THEN ${journalLinesTable.debit} - ${journalLinesTable.credit} ELSE 0 END), 0)`,
          cashLines: sql<string>`COALESCE(SUM(CASE WHEN ${accountsTable.code} = '1000' THEN 1 ELSE 0 END), 0)`,
        })
        .from(journalLinesTable)
        .innerJoin(
          accountsTable,
          and(
            eq(accountsTable.id, journalLinesTable.accountId),
            eq(accountsTable.orgId, journalLinesTable.orgId),
          ),
        )
        .where(
          and(
            eq(journalLinesTable.orgId, orgId),
            inArray(journalLinesTable.entryId, ids),
          ),
        )
        .groupBy(journalLinesTable.entryId);
      for (const s of sums) {
        const touchesCash = BigInt(s.cashLines) > 0n;
        activity.set(
          s.entryId,
          touchesCash ? BigInt(s.cashNet) : BigInt(s.totalDebit),
        );
      }
    }

    res.json(
      GetOrgDashboardResponse.parse({
        cash: formatMoney(cash),
        netIncome: formatMoney(netIncome),
        totalDebit: formatMoney(trial.totalDebit),
        totalCredit: formatMoney(trial.totalCredit),
        difference: formatMoney(trial.difference),
        balanced: trial.difference === 0n,
        recentActivity: entries.map((e) => ({
          id: e.id,
          entryDate: e.entryDate,
          memo: e.memo,
          source: e.source,
          amount: formatMoney(activity.get(e.id) ?? 0n),
        })),
      }),
    );
  } catch (err) {
    sendLedgerError(res, err);
  }
});

export default router;
