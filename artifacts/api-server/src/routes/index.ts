import { Router, type IRouter } from "express";
import healthRouter from "./health";
import { createAuthRouter } from "./auth";
import practiceRouter from "./practice";
import closeRouter from "./close";
import orgsRouter from "./orgs";
import reportsRouter from "./reports";
import bankRouter from "./bank";
import invoicesRouter from "./invoices";
import taxRouter from "./tax";
import importRouter from "./import";
import billsRouter from "./bills";
import payrollRouter from "./payroll";
import membersRouter from "./members";
import { requireAuth } from "../middlewares/auth";

export interface RouterOptions {
  /** Max auth requests per IP per window. Overridable for tests. */
  authRateLimitMax?: number;
}

export function createRouter(options: RouterOptions = {}): IRouter {
  const router = Router();

  // Public: health + auth (login/signup/logout/session).
  router.use(healthRouter);
  router.use(createAuthRouter({ rateLimitMax: options.authRateLimitMax }));

  // Everything below requires a valid session. Identity always comes from the
  // session here — the client never supplies a userId.
  router.use(requireAuth);
  router.use(practiceRouter);
  router.use(closeRouter);
  router.use(orgsRouter);
  router.use(reportsRouter);
  router.use(bankRouter);
  router.use(invoicesRouter);
  router.use(taxRouter);
  router.use(importRouter);
  router.use(billsRouter);
  router.use(payrollRouter);
  router.use(membersRouter);

  return router;
}

export default createRouter;
