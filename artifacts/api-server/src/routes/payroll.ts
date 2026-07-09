import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, payrollRunsTable } from "@workspace/db";
import {
  ListPayrollRunsParams,
  ListPayrollRunsResponse,
} from "@workspace/api-zod";
import { requirePermission, formatMoney } from "@workspace/ledger";
import { sendLedgerError } from "../lib/errors";
import { getSessionUserId } from "../middlewares/auth";

const router: IRouter = Router();

router.get("/orgs/:orgId/payroll-runs", async (req, res) => {
  try {
    const userId = getSessionUserId(req);
    const { orgId } = ListPayrollRunsParams.parse(req.params);
    await requirePermission(orgId, userId, "reports.read");

    const runs = await db
      .select()
      .from(payrollRunsTable)
      .where(eq(payrollRunsTable.orgId, orgId))
      .orderBy(desc(payrollRunsTable.payDate));

    res.json(
      ListPayrollRunsResponse.parse({
        payrollRuns: runs.map((r) => ({
          id: r.id,
          provider: r.provider,
          externalId: r.externalId,
          payDate: r.payDate,
          grossPay: formatMoney(r.grossPay),
          taxes: formatMoney(r.taxes),
          netPay: formatMoney(r.netPay),
        })),
      }),
    );
  } catch (err) {
    sendLedgerError(res, err);
  }
});

export default router;
