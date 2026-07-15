import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db, budgetsTable, type DimensionType } from "@workspace/db";
import {
  ListOrgDimensionsParams,
  ListOrgDimensionsResponse,
  CreateOrgDimensionParams,
  CreateOrgDimensionBody,
  CreateOrgDimensionResponse,
  RunCustomReportParams,
  RunCustomReportBody,
  RunCustomReportResponse,
  ListOrgBudgetsParams,
  ListOrgBudgetsResponse,
  CreateOrgBudgetParams,
  CreateOrgBudgetBody,
  CreateOrgBudgetResponse,
  SetOrgBudgetLineParams,
  SetOrgBudgetLineBody,
  SetOrgBudgetLineResponse,
  GetBudgetVsActualReportParams,
  GetBudgetVsActualReportResponse,
} from "@workspace/api-zod";
import {
  listDimensions,
  createDimension,
  runReport,
  listOrgsInGroup,
  createBudget,
  setBudgetLine,
  getBudgetVsActual,
  requirePermission,
  formatMoney,
  parseDecimalToMinor,
  ForbiddenError,
  type ReportQuery,
} from "@workspace/ledger";
import { sendLedgerError } from "../lib/errors";
import { getSessionUserId } from "../middlewares/auth";

const router: IRouter = Router();

router.get("/orgs/:orgId/dimensions", async (req, res) => {
  try {
    const { orgId } = ListOrgDimensionsParams.parse(req.params);
    const userId = getSessionUserId(req);
    await requirePermission(orgId, userId, "reports.read");
    const dimensions = await listDimensions(orgId);
    res.json(
      ListOrgDimensionsResponse.parse({
        dimensions: dimensions.map((d) => ({
          id: d.id,
          type: d.type,
          name: d.name,
        })),
      }),
    );
  } catch (err) {
    sendLedgerError(res, err);
  }
});

router.post("/orgs/:orgId/dimensions", async (req, res) => {
  try {
    const { orgId } = CreateOrgDimensionParams.parse(req.params);
    const userId = getSessionUserId(req);
    await requirePermission(orgId, userId, "ledger.post");
    const body = CreateOrgDimensionBody.parse(req.body);
    const dimension = await createDimension(
      orgId,
      body.type as DimensionType,
      body.name,
      { actor: userId },
    );
    res.status(201).json(
      CreateOrgDimensionResponse.parse({
        id: dimension.id,
        type: dimension.type,
        name: dimension.name,
      }),
    );
  } catch (err) {
    sendLedgerError(res, err);
  }
});

router.post("/orgs/:orgId/report", async (req, res) => {
  try {
    const { orgId } = RunCustomReportParams.parse(req.params);
    const userId = getSessionUserId(req);
    await requirePermission(orgId, userId, "reports.read");
    const body = RunCustomReportBody.parse(req.body);

    // Scope is exactly one of orgId or groupId. Group scope reads every
    // member ledger, so it demands reports.read in each — and the requesting
    // org must itself belong to the group.
    const query: ReportQuery = {
      groupBy: body.groupBy as ReportQuery["groupBy"],
      filters: body.filters as ReportQuery["filters"],
    };
    if (body.groupId) {
      const members = await listOrgsInGroup(body.groupId);
      if (!members.includes(orgId)) {
        throw new ForbiddenError(
          "Organization is not a member of that group.",
        );
      }
      for (const member of members) {
        await requirePermission(member, userId, "reports.read");
      }
      query.groupId = body.groupId;
    } else {
      query.orgId = orgId;
    }

    const result = await runReport(query);
    res.json(
      RunCustomReportResponse.parse({
        rows: result.rows.map((r) => ({
          keys: r.keys,
          debit: formatMoney(r.debit),
          credit: formatMoney(r.credit),
          balance: formatMoney(r.balance),
        })),
        totalDebit: formatMoney(result.totalDebit),
        totalCredit: formatMoney(result.totalCredit),
      }),
    );
  } catch (err) {
    sendLedgerError(res, err);
  }
});

router.get("/orgs/:orgId/budgets", async (req, res) => {
  try {
    const { orgId } = ListOrgBudgetsParams.parse(req.params);
    const userId = getSessionUserId(req);
    await requirePermission(orgId, userId, "reports.read");
    const budgets = await db
      .select()
      .from(budgetsTable)
      .where(eq(budgetsTable.orgId, orgId))
      .orderBy(desc(budgetsTable.createdAt));
    res.json(
      ListOrgBudgetsResponse.parse({
        budgets: budgets.map((b) => ({
          id: b.id,
          name: b.name,
          periodStart: b.periodStart,
          periodEnd: b.periodEnd,
        })),
      }),
    );
  } catch (err) {
    sendLedgerError(res, err);
  }
});

router.post("/orgs/:orgId/budgets", async (req, res) => {
  try {
    const { orgId } = CreateOrgBudgetParams.parse(req.params);
    const userId = getSessionUserId(req);
    await requirePermission(orgId, userId, "ledger.post");
    const body = CreateOrgBudgetBody.parse(req.body);
    const budget = await createBudget(orgId, body, { actor: userId });
    res.status(201).json(
      CreateOrgBudgetResponse.parse({
        id: budget.id,
        name: budget.name,
        periodStart: budget.periodStart,
        periodEnd: budget.periodEnd,
      }),
    );
  } catch (err) {
    sendLedgerError(res, err);
  }
});

router.post("/orgs/:orgId/budgets/:budgetId/lines", async (req, res) => {
  try {
    const { orgId, budgetId } = SetOrgBudgetLineParams.parse(req.params);
    const userId = getSessionUserId(req);
    await requirePermission(orgId, userId, "ledger.post");
    const body = SetOrgBudgetLineBody.parse(req.body);
    const line = await setBudgetLine(
      orgId,
      budgetId,
      body.accountId,
      parseDecimalToMinor(body.amount, "budget.amount"),
      { actor: userId },
    );
    res.json(
      SetOrgBudgetLineResponse.parse({
        id: line.id,
        accountId: line.accountId,
        amount: formatMoney(line.amount),
      }),
    );
  } catch (err) {
    sendLedgerError(res, err);
  }
});

router.get("/orgs/:orgId/budgets/:budgetId/vs-actual", async (req, res) => {
  try {
    const { orgId, budgetId } = GetBudgetVsActualReportParams.parse(
      req.params,
    );
    const userId = getSessionUserId(req);
    await requirePermission(orgId, userId, "reports.read");
    const report = await getBudgetVsActual(orgId, budgetId);
    res.json(
      GetBudgetVsActualReportResponse.parse({
        budget: {
          id: report.budget.id,
          name: report.budget.name,
          periodStart: report.budget.periodStart,
          periodEnd: report.budget.periodEnd,
        },
        rows: report.rows.map((r) => ({
          accountId: r.accountId,
          code: r.code,
          name: r.name,
          type: r.type,
          budgeted: formatMoney(r.budgeted),
          actual: formatMoney(r.actual),
          variance: formatMoney(r.variance),
        })),
        totalBudgeted: formatMoney(report.totalBudgeted),
        totalActual: formatMoney(report.totalActual),
        totalVariance: formatMoney(report.totalVariance),
      }),
    );
  } catch (err) {
    sendLedgerError(res, err);
  }
});

export default router;
