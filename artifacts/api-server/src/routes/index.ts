import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
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
import importPreviewRouter from "./import-preview";
import bankStatementRouter from "./bank-statement";
import billsRouter from "./bills";
import payrollRouter from "./payroll";
import membersRouter from "./members";
import groupsRouter from "./groups";
import approvalsRouter from "./approvals";
import analyticsRouter from "./analytics";
import { requireAuth } from "../middlewares/auth";
import { requireMasterAdmin } from "../middlewares/master-admin";
import platformAdminRouter from "./platform-admin";
import credentialRouter from "./credentials";
import taxFormsRouter from "./tax-forms";
import machineFinanceRouter from "./machine-finance";
import { requireMachineCredential } from "../middlewares/machine-credentials";

export interface RouterOptions {
  /** Max auth requests per IP per window. Overridable for tests. */
  authRateLimitMax?: number;
  /** Max requests per IP per window across the whole API. Overridable for tests. */
  apiRateLimitMax?: number;
  /** Max requests per IP per window on expensive endpoints. Overridable for tests. */
  heavyRateLimitMax?: number;
  /** Max platform password-reset triggers per IP per window. */
  platformResetRateLimitMax?: number;
}

const RATE_WINDOW_MS = 15 * 60 * 1000;

/** Parse an env cap; a missing or non-numeric value falls back to the default. */
function envMax(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function makeLimiter(max: number) {
  return rateLimit({
    windowMs: RATE_WINDOW_MS,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) =>
      res.status(429).json({ error: "Too many requests. Try again later." }),
  });
}

export function createRouter(options: RouterOptions = {}): IRouter {
  const router = Router();

  // Global backstop limiter: generous enough that normal UI usage (dashboards
  // fan out many queries) never trips it, but caps abuse. Env-configurable.
  const apiMax = options.apiRateLimitMax ?? envMax("API_RATE_LIMIT_MAX", 1000);
  router.use(makeLimiter(apiMax));

  // Stricter limiter for CPU/DB-heavy endpoints: file-import parsing, batch
  // exports/reports across clients, custom reports, consolidated statements.
  const heavyMax =
    options.heavyRateLimitMax ?? envMax("HEAVY_RATE_LIMIT_MAX", 60);
  const heavyLimiter = makeLimiter(heavyMax);
  router.use(
    [
      "/orgs/:orgId/import/preview",
      "/orgs/:orgId/bank/statement/extract",
      "/orgs/:orgId/bank/statement/confirm",
      "/practice/batch-export",
      "/practice/batch-report",
      "/orgs/:orgId/report",
      "/groups/:groupId/consolidated",
    ],
    heavyLimiter,
  );

  // Public: health + auth (login/signup/logout/session).
  router.use(healthRouter);
  router.use(createAuthRouter({ rateLimitMax: options.authRateLimitMax }));

  // Machine callers have a separate, explicitly scoped surface. Never pass a
  // bearer request into the session-based routers below (even if a cookie is
  // also attached). Each finance handler checks both the org and its scope.
  router.use("/integrations", requireMachineCredential);
  router.use(machineFinanceRouter);
  router.use((req, res, next) => {
    if (req.headers.authorization) {
      res.status(401).json({ error: "Bearer credentials are only valid on integration endpoints." });
      return;
    }
    next();
  });

  // Everything below requires a valid session. Identity always comes from the
  // session here — the client never supplies a userId.
  router.use(requireAuth);
  router.use(credentialRouter);
  router.use(taxFormsRouter);
  router.use(
    "/platform-admin",
    requireMasterAdmin,
    platformAdminRouter({ resetRateLimitMax: options.platformResetRateLimitMax }),
  );
  router.use(practiceRouter);
  router.use(closeRouter);
  router.use(orgsRouter);
  router.use(reportsRouter);
  router.use(bankRouter);
  router.use(bankStatementRouter);
  router.use(invoicesRouter);
  router.use(taxRouter);
  router.use(importPreviewRouter);
  router.use(importRouter);
  router.use(billsRouter);
  router.use(payrollRouter);
  router.use(membersRouter);
  router.use(groupsRouter);
  router.use(approvalsRouter);
  router.use(analyticsRouter);

  return router;
}

export default createRouter;
