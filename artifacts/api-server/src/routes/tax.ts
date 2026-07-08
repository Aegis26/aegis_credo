import { Router, type IRouter } from "express";
import {
  GetTaxEstimateParams,
  GetTaxEstimateQueryParams,
  GetTaxEstimateResponse,
} from "@workspace/api-zod";
import {
  requirePermission,
  getTrialBalance,
  formatMoney,
} from "@workspace/ledger";
import { sendLedgerError } from "../lib/errors";
import { getSessionUserId } from "../middlewares/auth";

const router: IRouter = Router();

const DISCLAIMER =
  "This is a rough set-aside estimate for cash planning only. It is not tax " +
  "advice, not a filing, and does not account for deductions, credits, or your " +
  "specific situation. Consult a qualified tax professional.";

router.get("/orgs/:orgId/tax-estimate", async (req, res) => {
  try {
    const userId = getSessionUserId(req);
    const { orgId } = GetTaxEstimateParams.parse(req.params);
    const { rate } = GetTaxEstimateQueryParams.parse(req.query);
    await requirePermission(orgId, userId, "reports.read");

    const effectiveRate = rate ?? 0.25;
    const trial = await getTrialBalance(orgId);
    let netIncome = 0n;
    for (const r of trial.rows) {
      if (r.type === "revenue") netIncome += r.balance;
      if (r.type === "expense") netIncome -= r.balance;
    }

    // Keep money in integer minor units: scale the rate to basis points and
    // divide, so no JS float ever multiplies a monetary BigInt.
    const rateBps = BigInt(Math.round(effectiveRate * 10_000));
    const setAside =
      netIncome > 0n ? (netIncome * rateBps) / 10_000n : 0n;

    res.json(
      GetTaxEstimateResponse.parse({
        netIncome: formatMoney(netIncome),
        rate: effectiveRate,
        estimatedSetAside: formatMoney(setAside),
        disclaimer: DISCLAIMER,
      }),
    );
  } catch (err) {
    sendLedgerError(res, err);
  }
});

export default router;
