import { Router, type IRouter } from "express";
import {
  ListPracticeClientsResponse,
  GetPracticeDashboardQueryParams,
  GetPracticeDashboardResponse,
  BatchExportReportsBody,
  BatchExportReportsResponse,
  CreatePracticeBody,
  CreatePracticeResponse,
  GrantPracticeClientParams,
  GrantPracticeClientBody,
  GrantPracticeClientResponse,
  SwitchToClientParams,
  SwitchToClientResponse,
  RunBatchReportBody,
  RunBatchReportResponse,
} from "@workspace/api-zod";
import {
  listClientsForPracticeUser,
  getPracticeDashboard,
  batchExport,
  formatMoney,
  createPractice,
  addPracticeMember,
  grantClientAccess,
  switchToClient,
  runBatchReport,
  batchReportToWorkbook,
  requirePermission,
} from "@workspace/ledger";
import { sendLedgerError } from "../lib/errors";
import { getSessionUserId } from "../middlewares/auth";

const router: IRouter = Router();

router.get("/practice/clients", async (req, res) => {
  try {
    const userId = getSessionUserId(req);
    const clients = await listClientsForPracticeUser(userId);
    res.json(ListPracticeClientsResponse.parse({ clients }));
  } catch (err) {
    sendLedgerError(res, err);
  }
});

router.get("/practice/dashboard", async (req, res) => {
  try {
    const userId = getSessionUserId(req);
    const { practiceId } = GetPracticeDashboardQueryParams.parse(req.query);
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
    const userId = getSessionUserId(req);
    const body = BatchExportReportsBody.parse(req.body);
    const result = await batchExport(
      userId,
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

// Create a practice: the session user becomes its owner member. Membership
// alone grants no client access — grants are a separate, audited step.
router.post("/practice", async (req, res) => {
  try {
    const userId = getSessionUserId(req);
    const body = CreatePracticeBody.parse(req.body);
    const practice = await createPractice(body.name);
    await addPracticeMember(practice.id, userId, { role: "owner" });
    res
      .status(201)
      .json(
        CreatePracticeResponse.parse({ id: practice.id, name: practice.name }),
      );
  } catch (err) {
    sendLedgerError(res, err);
  }
});

// Grant a practice access to a client org. The gate protects the CLIENT'S
// data: the caller must hold members.manage on the client org (i.e. the
// client's admin authorizes their own books to the firm). A practice member
// can therefore never self-grant an org they do not administer.
// Audit-logged against the client org by the library.
router.post("/practice/:practiceId/clients", async (req, res) => {
  try {
    const userId = getSessionUserId(req);
    const { practiceId } = GrantPracticeClientParams.parse(req.params);
    const body = GrantPracticeClientBody.parse(req.body);

    await requirePermission(body.orgId, userId, "members.manage");

    const grant = await grantClientAccess(practiceId, body.orgId, {
      actor: userId,
      grantedBy: userId,
    });
    res.status(201).json(
      GrantPracticeClientResponse.parse({
        practiceId: grant.practiceId,
        orgId: grant.orgId,
        active: grant.revokedAt === null,
      }),
    );
  } catch (err) {
    sendLedgerError(res, err);
  }
});

// Audited switch into a granted client. assertClientAccess runs inside.
router.post("/practice/switch/:orgId", async (req, res) => {
  try {
    const userId = getSessionUserId(req);
    const { orgId } = SwitchToClientParams.parse(req.params);
    const org = await switchToClient(userId, orgId, { actor: userId });
    res.json(SwitchToClientResponse.parse({ id: org.id, name: org.name }));
  } catch (err) {
    sendLedgerError(res, err);
  }
});

// Run the same report across a book of clients; scope is enforced inside
// runBatchReport via accessibleClients (403 on ungranted unless skipped).
router.post("/practice/batch-report", async (req, res) => {
  try {
    const userId = getSessionUserId(req);
    const body = RunBatchReportBody.parse(req.body);
    const entries = await runBatchReport(userId, body.orgIds, body.kind, {
      skipUnauthorized: body.skipUnauthorized ?? false,
    });
    const workbook = batchReportToWorkbook(entries, body.kind);
    res.json(
      RunBatchReportResponse.parse({
        kind: body.kind,
        clients: entries.map((e) => ({ orgId: e.orgId, name: e.name })),
        sheets: workbook.sheets.map((s) => ({
          name: s.name,
          columns: s.columns,
          rows: s.rows.map((r) => r.map((cell) => String(cell))),
        })),
      }),
    );
  } catch (err) {
    sendLedgerError(res, err);
  }
});

export default router;
