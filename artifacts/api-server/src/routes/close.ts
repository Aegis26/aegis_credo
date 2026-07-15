import { Router, type IRouter } from "express";
import {
  ListClosePeriodsParams,
  ListClosePeriodsResponse,
  GetCloseStatusParams,
  GetCloseStatusResponse,
  CreateClosePeriodParams,
  CreateClosePeriodBody,
  CreateClosePeriodResponse,
  SetClosePeriodStatusParams,
  SetClosePeriodStatusBody,
  SetClosePeriodStatusResponse,
  AddCloseTaskParams,
  AddCloseTaskBody,
  AddCloseTaskResponse,
  SetCloseTaskStatusParams,
  SetCloseTaskStatusBody,
  SetCloseTaskStatusResponse,
  CreatePbcRequestParams,
  CreatePbcRequestBody,
  CreatePbcRequestResponse,
  AcceptPbcRequestParams,
  AcceptPbcRequestResponse,
  GetMyCloseStatusParams,
  GetMyCloseStatusResponse,
  RespondPbcRequestParams,
  RespondPbcRequestBody,
  RespondPbcRequestResponse,
} from "@workspace/api-zod";
import {
  assertClientAccess,
  listClosePeriods,
  getCloseStatus,
  createClosePeriod,
  setClosePeriodStatus,
  addCloseTask,
  setCloseTaskStatus,
  createPbcRequest,
  acceptPbcRequest,
  respondPbcRequest,
  getLatestCloseSummary,
  requirePermission,
  type CloseStatusSummary,
} from "@workspace/ledger";
import { sendLedgerError } from "../lib/errors";
import { getSessionUserId } from "../middlewares/auth";

const router: IRouter = Router();

function serializeSummary(status: CloseStatusSummary) {
  return {
    period: {
      id: status.period.id,
      period: status.period.period,
      status: status.period.status,
    },
    tasks: {
      total: status.tasks.total,
      done: status.tasks.done,
      inProgress: status.tasks.inProgress,
      pending: status.tasks.pending,
      progress: status.tasks.progress,
      items: status.tasks.items.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        sortOrder: t.sortOrder,
      })),
    },
    pbc: {
      total: status.pbc.total,
      requested: status.pbc.requested,
      provided: status.pbc.provided,
      accepted: status.pbc.accepted,
      open: status.pbc.open,
      items: status.pbc.items.map((p) => ({
        id: p.id,
        title: p.title,
        status: p.status,
        detail: p.detail,
        response: p.response,
      })),
    },
  };
}

router.get("/clients/:orgId/close-periods", async (req, res) => {
  try {
    const { orgId } = ListClosePeriodsParams.parse(req.params);
    const userId = getSessionUserId(req);
    // Access is caller-enforced: the ledger core performs no auth.
    await assertClientAccess(userId, orgId);
    const periods = await listClosePeriods(orgId);
    res.json(
      ListClosePeriodsResponse.parse({
        periods: periods.map((p) => ({
          id: p.id,
          period: p.period,
          status: p.status,
        })),
      }),
    );
  } catch (err) {
    sendLedgerError(res, err);
  }
});

router.get(
  "/clients/:orgId/close-periods/:periodId/status",
  async (req, res) => {
    try {
      const { orgId, periodId } = GetCloseStatusParams.parse(req.params);
      const userId = getSessionUserId(req);
      await assertClientAccess(userId, orgId);
      const status = await getCloseStatus(orgId, periodId);
      res.json(GetCloseStatusResponse.parse(serializeSummary(status)));
    } catch (err) {
      sendLedgerError(res, err);
    }
  },
);

// ---- Practice-side close writes. Every route derives the user from the
// session and enforces the client grant server-side (assertClientAccess)
// BEFORE touching any data. The library audit-logs each mutation.

router.post("/clients/:orgId/close-periods/create", async (req, res) => {
  try {
    const { orgId } = CreateClosePeriodParams.parse(req.params);
    const userId = getSessionUserId(req);
    await assertClientAccess(userId, orgId);
    const body = CreateClosePeriodBody.parse(req.body);
    const period = await createClosePeriod(orgId, body.period, {
      actor: userId,
    });
    res.status(201).json(
      CreateClosePeriodResponse.parse({
        id: period.id,
        period: period.period,
        status: period.status,
      }),
    );
  } catch (err) {
    sendLedgerError(res, err);
  }
});

router.post(
  "/clients/:orgId/close-periods/:periodId/set-status",
  async (req, res) => {
    try {
      const { orgId, periodId } = SetClosePeriodStatusParams.parse(req.params);
      const userId = getSessionUserId(req);
      await assertClientAccess(userId, orgId);
      const body = SetClosePeriodStatusBody.parse(req.body);
      const period = await setClosePeriodStatus(orgId, periodId, body.status, {
        actor: userId,
        closedBy: userId,
      });
      res.json(
        SetClosePeriodStatusResponse.parse({
          id: period.id,
          period: period.period,
          status: period.status,
        }),
      );
    } catch (err) {
      sendLedgerError(res, err);
    }
  },
);

router.post(
  "/clients/:orgId/close-periods/:periodId/tasks",
  async (req, res) => {
    try {
      const { orgId, periodId } = AddCloseTaskParams.parse(req.params);
      const userId = getSessionUserId(req);
      await assertClientAccess(userId, orgId);
      const body = AddCloseTaskBody.parse(req.body);
      const task = await addCloseTask(orgId, periodId, body.title, {
        actor: userId,
        sortOrder: body.sortOrder,
      });
      res.status(201).json(
        AddCloseTaskResponse.parse({
          id: task.id,
          title: task.title,
          status: task.status,
          sortOrder: task.sortOrder,
        }),
      );
    } catch (err) {
      sendLedgerError(res, err);
    }
  },
);

router.post(
  "/clients/:orgId/close-tasks/:taskId/set-status",
  async (req, res) => {
    try {
      const { orgId, taskId } = SetCloseTaskStatusParams.parse(req.params);
      const userId = getSessionUserId(req);
      await assertClientAccess(userId, orgId);
      const body = SetCloseTaskStatusBody.parse(req.body);
      const task = await setCloseTaskStatus(orgId, taskId, body.status, {
        actor: userId,
        completedBy: userId,
      });
      res.json(
        SetCloseTaskStatusResponse.parse({
          id: task.id,
          title: task.title,
          status: task.status,
          sortOrder: task.sortOrder,
        }),
      );
    } catch (err) {
      sendLedgerError(res, err);
    }
  },
);

router.post(
  "/clients/:orgId/close-periods/:periodId/pbc",
  async (req, res) => {
    try {
      const { orgId, periodId } = CreatePbcRequestParams.parse(req.params);
      const userId = getSessionUserId(req);
      await assertClientAccess(userId, orgId);
      const body = CreatePbcRequestBody.parse(req.body);
      const pbc = await createPbcRequest(orgId, periodId, body.title, {
        actor: userId,
        detail: body.detail,
        requestedBy: userId,
      });
      res.status(201).json(
        CreatePbcRequestResponse.parse({
          id: pbc.id,
          title: pbc.title,
          status: pbc.status,
          detail: pbc.detail,
          response: pbc.response,
        }),
      );
    } catch (err) {
      sendLedgerError(res, err);
    }
  },
);

router.post("/clients/:orgId/pbc/:requestId/accept", async (req, res) => {
  try {
    const { orgId, requestId } = AcceptPbcRequestParams.parse(req.params);
    const userId = getSessionUserId(req);
    await assertClientAccess(userId, orgId);
    const pbc = await acceptPbcRequest(orgId, requestId, { actor: userId });
    res.json(
      AcceptPbcRequestResponse.parse({
        id: pbc.id,
        title: pbc.title,
        status: pbc.status,
        detail: pbc.detail,
        response: pbc.response,
      }),
    );
  } catch (err) {
    sendLedgerError(res, err);
  }
});

// ---- Client-side close views. Gated by ORG MEMBERSHIP (requirePermission),
// not by a practice grant — this is the client answering their accountant.

router.get("/orgs/:orgId/close-status", async (req, res) => {
  try {
    const { orgId } = GetMyCloseStatusParams.parse(req.params);
    const userId = getSessionUserId(req);
    await requirePermission(orgId, userId, "reports.read");
    const summary = await getLatestCloseSummary(orgId);
    res.json(
      GetMyCloseStatusResponse.parse({
        summary: summary ? serializeSummary(summary) : null,
      }),
    );
  } catch (err) {
    sendLedgerError(res, err);
  }
});

router.post("/orgs/:orgId/pbc/:requestId/respond", async (req, res) => {
  try {
    const { orgId, requestId } = RespondPbcRequestParams.parse(req.params);
    const userId = getSessionUserId(req);
    await requirePermission(orgId, userId, "ledger.post");
    const body = RespondPbcRequestBody.parse(req.body);
    const pbc = await respondPbcRequest(orgId, requestId, body.response, {
      actor: userId,
    });
    res.json(
      RespondPbcRequestResponse.parse({
        id: pbc.id,
        title: pbc.title,
        status: pbc.status,
        detail: pbc.detail,
        response: pbc.response,
      }),
    );
  } catch (err) {
    sendLedgerError(res, err);
  }
});

export default router;
