import { Router, type IRouter } from "express";
import { inArray } from "drizzle-orm";
import { db, groupsTable, organizationsTable } from "@workspace/db";
import {
  ListGroupsResponse,
  CreateGroupBody,
  CreateGroupResponse,
  AddOrgToGroupParams,
  AddOrgToGroupBody,
  AddOrgToGroupResponse,
  GetConsolidatedTrialBalanceReportParams,
  GetConsolidatedTrialBalanceReportResponse,
  GetConsolidatedProfitAndLossReportParams,
  GetConsolidatedProfitAndLossReportResponse,
  GetConsolidatedBalanceSheetReportParams,
  GetConsolidatedBalanceSheetReportResponse,
} from "@workspace/api-zod";
import {
  createGroup,
  addOrgToGroup,
  listOrgsInGroup,
  listOrgsForUser,
  requirePermission,
  getConsolidatedTrialBalance,
  getConsolidatedProfitAndLoss,
  getConsolidatedBalanceSheet,
  formatMoney,
  ForbiddenError,
  type ConsolidatedRow,
} from "@workspace/ledger";
import { sendLedgerError } from "../lib/errors";
import { getSessionUserId } from "../middlewares/auth";

const router: IRouter = Router();

/**
 * Consolidated reads span every entity ledger in the group, so the caller
 * must hold reports.read in EVERY member org. Consolidation itself is
 * read-only over the entity ledgers.
 */
async function assertGroupReadAccess(
  userId: string,
  groupId: string,
): Promise<string[]> {
  const members = await listOrgsInGroup(groupId);
  if (members.length === 0) {
    throw new ForbiddenError("Group has no member organizations.");
  }
  for (const orgId of members) {
    await requirePermission(orgId, userId, "reports.read");
  }
  return members;
}

async function orgNames(
  orgIds: string[],
): Promise<{ orgId: string; name: string }[]> {
  if (orgIds.length === 0) return [];
  const rows = await db
    .select({ id: organizationsTable.id, name: organizationsTable.name })
    .from(organizationsTable)
    .where(inArray(organizationsTable.id, orgIds));
  const byId = new Map(rows.map((r) => [r.id, r.name]));
  return orgIds.map((id) => ({ orgId: id, name: byId.get(id) ?? id }));
}

function serializeRow(r: ConsolidatedRow) {
  return {
    code: r.code,
    name: r.name,
    type: r.type,
    normalBalance: r.normalBalance,
    debit: formatMoney(r.debit),
    credit: formatMoney(r.credit),
    balance: formatMoney(r.balance),
  };
}

router.get("/groups", async (req, res) => {
  try {
    const userId = getSessionUserId(req);
    const orgIds = await listOrgsForUser(userId);
    if (orgIds.length === 0) {
      res.json(ListGroupsResponse.parse({ groups: [] }));
      return;
    }
    const myOrgs = await db
      .select({ id: organizationsTable.id, groupId: organizationsTable.groupId })
      .from(organizationsTable)
      .where(inArray(organizationsTable.id, orgIds));
    const groupIds = [
      ...new Set(myOrgs.map((o) => o.groupId).filter((g): g is string => !!g)),
    ];
    if (groupIds.length === 0) {
      res.json(ListGroupsResponse.parse({ groups: [] }));
      return;
    }
    const groups = await db
      .select()
      .from(groupsTable)
      .where(inArray(groupsTable.id, groupIds));
    const result = [];
    for (const g of groups) {
      const members = await listOrgsInGroup(g.id);
      result.push({ id: g.id, name: g.name, orgs: await orgNames(members) });
    }
    res.json(ListGroupsResponse.parse({ groups: result }));
  } catch (err) {
    sendLedgerError(res, err);
  }
});

router.post("/groups", async (req, res) => {
  try {
    const userId = getSessionUserId(req);
    const body = CreateGroupBody.parse(req.body);
    const group = await createGroup(body.name, { actor: userId });
    res.status(201).json(
      CreateGroupResponse.parse({ id: group.id, name: group.name }),
    );
  } catch (err) {
    sendLedgerError(res, err);
  }
});

router.post("/groups/:groupId/orgs", async (req, res) => {
  try {
    const { groupId } = AddOrgToGroupParams.parse(req.params);
    const userId = getSessionUserId(req);
    const body = AddOrgToGroupBody.parse(req.body);
    // Attaching an org to a group is an administrative act on THAT org: the
    // caller must be able to manage it. The org's ledger is never touched.
    await requirePermission(body.orgId, userId, "members.manage");
    await addOrgToGroup(groupId, body.orgId, { actor: userId });
    res.json(AddOrgToGroupResponse.parse({ ok: true }));
  } catch (err) {
    sendLedgerError(res, err);
  }
});

router.get("/groups/:groupId/consolidated/trial-balance", async (req, res) => {
  try {
    const { groupId } = GetConsolidatedTrialBalanceReportParams.parse(
      req.params,
    );
    const userId = getSessionUserId(req);
    const members = await assertGroupReadAccess(userId, groupId);
    const tb = await getConsolidatedTrialBalance(groupId);
    res.json(
      GetConsolidatedTrialBalanceReportResponse.parse({
        groupId,
        entities: await orgNames(members),
        combined: tb.combined.map(serializeRow),
        eliminations: tb.eliminations.map(serializeRow),
        consolidated: tb.consolidated.map(serializeRow),
        totalDebit: formatMoney(tb.totalDebit),
        totalCredit: formatMoney(tb.totalCredit),
        difference: formatMoney(tb.difference),
      }),
    );
  } catch (err) {
    sendLedgerError(res, err);
  }
});

router.get(
  "/groups/:groupId/consolidated/profit-and-loss",
  async (req, res) => {
    try {
      const { groupId } = GetConsolidatedProfitAndLossReportParams.parse(
        req.params,
      );
      const userId = getSessionUserId(req);
      const members = await assertGroupReadAccess(userId, groupId);
      const pl = await getConsolidatedProfitAndLoss(groupId);
      res.json(
        GetConsolidatedProfitAndLossReportResponse.parse({
          groupId,
          entities: await orgNames(members),
          revenue: formatMoney(pl.revenue),
          expenses: formatMoney(pl.expenses),
          netIncome: formatMoney(pl.netIncome),
        }),
      );
    } catch (err) {
      sendLedgerError(res, err);
    }
  },
);

router.get("/groups/:groupId/consolidated/balance-sheet", async (req, res) => {
  try {
    const { groupId } = GetConsolidatedBalanceSheetReportParams.parse(
      req.params,
    );
    const userId = getSessionUserId(req);
    const members = await assertGroupReadAccess(userId, groupId);
    const bs = await getConsolidatedBalanceSheet(groupId);
    res.json(
      GetConsolidatedBalanceSheetReportResponse.parse({
        groupId,
        entities: await orgNames(members),
        assets: formatMoney(bs.assets),
        liabilities: formatMoney(bs.liabilities),
        equity: formatMoney(bs.equity),
        netIncome: formatMoney(bs.netIncome),
        equityWithIncome: formatMoney(bs.equityWithIncome),
        balances: bs.balances,
      }),
    );
  } catch (err) {
    sendLedgerError(res, err);
  }
});

export default router;
