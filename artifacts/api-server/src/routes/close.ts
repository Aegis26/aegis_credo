import { Router, type IRouter } from "express";
import {
  ListClosePeriodsParams,
  ListClosePeriodsQueryParams,
  ListClosePeriodsResponse,
  GetCloseStatusParams,
  GetCloseStatusQueryParams,
  GetCloseStatusResponse,
} from "@workspace/api-zod";
import {
  assertClientAccess,
  listClosePeriods,
  getCloseStatus,
} from "@workspace/ledger";
import { sendLedgerError } from "../lib/errors";

const router: IRouter = Router();

router.get("/clients/:orgId/close-periods", async (req, res) => {
  try {
    const { orgId } = ListClosePeriodsParams.parse(req.params);
    const { userId } = ListClosePeriodsQueryParams.parse(req.query);
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
      const { userId } = GetCloseStatusQueryParams.parse(req.query);
      await assertClientAccess(userId, orgId);
      const status = await getCloseStatus(orgId, periodId);
      res.json(
        GetCloseStatusResponse.parse({
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
            })),
          },
        }),
      );
    } catch (err) {
      sendLedgerError(res, err);
    }
  },
);

export default router;
