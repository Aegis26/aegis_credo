import { Router, type IRouter } from "express";
import {
  ListPracticeClientsQueryParams,
  ListPracticeClientsResponse,
  GetPracticeDashboardQueryParams,
  GetPracticeDashboardResponse,
  BatchExportReportsBody,
  BatchExportReportsResponse,
} from "@workspace/api-zod";
import {
  listClientsForPracticeUser,
  getPracticeDashboard,
  batchExport,
  formatMoney,
} from "@workspace/ledger";
import { sendLedgerError } from "../lib/errors";

const router: IRouter = Router();

router.get("/practice/clients", async (req, res) => {
  try {
    const { userId } = ListPracticeClientsQueryParams.parse(req.query);
    const clients = await listClientsForPracticeUser(userId);
    res.json(ListPracticeClientsResponse.parse({ clients }));
  } catch (err) {
    sendLedgerError(res, err);
  }
});

router.get("/practice/dashboard", async (req, res) => {
  try {
    const { userId, practiceId } = GetPracticeDashboardQueryParams.parse(
      req.query,
    );
    const dashboard = await getPracticeDashboard(
      userId,
      practiceId ?? undefined,
    );
    res.json(
      GetPracticeDashboardResponse.parse({
        generatedAt: dashboard.generatedAt,
        clientCount: dashboard.clientCount,
        clients: dashboard.clients.map((c) => ({
          orgId: c.orgId,
          name: c.name,
          close: c.close,
          financials: {
            netIncome: formatMoney(c.financials.netIncome),
            assets: formatMoney(c.financials.assets),
            liabilities: formatMoney(c.financials.liabilities),
            balanced: c.financials.balanced,
          },
        })),
      }),
    );
  } catch (err) {
    sendLedgerError(res, err);
  }
});

router.post("/practice/batch-export", async (req, res) => {
  try {
    const body = BatchExportReportsBody.parse(req.body);
    const result = await batchExport(
      body.userId,
      body.orgIds,
      body.kind,
      body.format ?? "csv",
      { skipUnauthorized: body.skipUnauthorized ?? false },
    );
    res.json(BatchExportReportsResponse.parse(result));
  } catch (err) {
    sendLedgerError(res, err);
  }
});

export default router;
