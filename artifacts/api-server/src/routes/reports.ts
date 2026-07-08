import { Router, type IRouter } from "express";
import {
  GetTrialBalanceReportParams,
  GetTrialBalanceReportResponse,
  GetProfitAndLossReportParams,
  GetProfitAndLossReportResponse,
  GetBalanceSheetReportParams,
  GetBalanceSheetReportResponse,
} from "@workspace/api-zod";
import {
  requirePermission,
  getTrialBalance,
  formatMoney,
} from "@workspace/ledger";
import { sendLedgerError } from "../lib/errors";
import { getSessionUserId } from "../middlewares/auth";

const router: IRouter = Router();

router.get("/orgs/:orgId/reports/trial-balance", async (req, res) => {
  try {
    const userId = getSessionUserId(req);
    const { orgId } = GetTrialBalanceReportParams.parse(req.params);
    await requirePermission(orgId, userId, "reports.read");
    const trial = await getTrialBalance(orgId);
    res.json(
      GetTrialBalanceReportResponse.parse({
        rows: trial.rows.map((r) => ({
          accountId: r.accountId,
          code: r.code,
          name: r.name,
          type: r.type,
          debit: formatMoney(r.debit),
          credit: formatMoney(r.credit),
        })),
        totalDebit: formatMoney(trial.totalDebit),
        totalCredit: formatMoney(trial.totalCredit),
        difference: formatMoney(trial.difference),
        balanced: trial.difference === 0n,
      }),
    );
  } catch (err) {
    sendLedgerError(res, err);
  }
});

router.get("/orgs/:orgId/reports/profit-and-loss", async (req, res) => {
  try {
    const userId = getSessionUserId(req);
    const { orgId } = GetProfitAndLossReportParams.parse(req.params);
    await requirePermission(orgId, userId, "reports.read");
    const trial = await getTrialBalance(orgId);

    const revenue = trial.rows.filter((r) => r.type === "revenue");
    const expenses = trial.rows.filter((r) => r.type === "expense");
    const totalRevenue = revenue.reduce((acc, r) => acc + r.balance, 0n);
    const totalExpenses = expenses.reduce((acc, r) => acc + r.balance, 0n);

    const toLine = (r: (typeof trial.rows)[number]) => ({
      accountId: r.accountId,
      code: r.code,
      name: r.name,
      amount: formatMoney(r.balance),
    });

    res.json(
      GetProfitAndLossReportResponse.parse({
        revenue: revenue.filter((r) => r.balance !== 0n).map(toLine),
        expenses: expenses.filter((r) => r.balance !== 0n).map(toLine),
        totalRevenue: formatMoney(totalRevenue),
        totalExpenses: formatMoney(totalExpenses),
        netIncome: formatMoney(totalRevenue - totalExpenses),
      }),
    );
  } catch (err) {
    sendLedgerError(res, err);
  }
});

router.get("/orgs/:orgId/reports/balance-sheet", async (req, res) => {
  try {
    const userId = getSessionUserId(req);
    const { orgId } = GetBalanceSheetReportParams.parse(req.params);
    await requirePermission(orgId, userId, "reports.read");
    const trial = await getTrialBalance(orgId);

    const byType = (t: string) => trial.rows.filter((r) => r.type === t);
    const assets = byType("asset");
    const liabilities = byType("liability");
    const equity = byType("equity");
    const sum = (rows: typeof trial.rows) =>
      rows.reduce((acc, r) => acc + r.balance, 0n);

    const totalAssets = sum(assets);
    const totalLiabilities = sum(liabilities);
    const totalEquity = sum(equity);
    const netIncome =
      sum(byType("revenue")) - sum(byType("expense"));
    const equityWithIncome = totalEquity + netIncome;

    const toLine = (r: (typeof trial.rows)[number]) => ({
      accountId: r.accountId,
      code: r.code,
      name: r.name,
      amount: formatMoney(r.balance),
    });

    res.json(
      GetBalanceSheetReportResponse.parse({
        assets: assets.filter((r) => r.balance !== 0n).map(toLine),
        liabilities: liabilities.filter((r) => r.balance !== 0n).map(toLine),
        equity: equity.filter((r) => r.balance !== 0n).map(toLine),
        totalAssets: formatMoney(totalAssets),
        totalLiabilities: formatMoney(totalLiabilities),
        totalEquity: formatMoney(totalEquity),
        netIncome: formatMoney(netIncome),
        equityWithIncome: formatMoney(equityWithIncome),
        totalLiabilitiesAndEquity: formatMoney(totalLiabilities + equityWithIncome),
        balanced: totalAssets === totalLiabilities + equityWithIncome,
      }),
    );
  } catch (err) {
    sendLedgerError(res, err);
  }
});

export default router;
