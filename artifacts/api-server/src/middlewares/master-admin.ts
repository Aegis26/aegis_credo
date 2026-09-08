import type { NextFunction, Request, Response } from "express";
import { db, platformAuditLogTable } from "@workspace/db";
import {
  configuredMasterEmail,
  normalizeEmail,
} from "../lib/auth-service";

export async function platformAudit(
  req: Request,
  action: string,
  entity: string,
  entityId: string,
  outcome: "success" | "denied",
  detail?: Record<string, unknown>,
): Promise<void> {
  await db.insert(platformAuditLogTable).values({
    actorUserId: req.userId ?? null, action, entity, entityId, outcome,
    requestId: typeof req.id === "string" ? req.id : null, detail: detail ?? null,
  });
}

export function platformAuditValues(
  req: Request,
  action: string,
  entity: string,
  entityId: string,
  outcome: "success" | "denied",
  detail?: Record<string, unknown>,
) {
  return {
    actorUserId: req.userId ?? null,
    action,
    entity,
    entityId,
    outcome,
    requestId: typeof req.id === "string" ? req.id : null,
    detail: detail ?? null,
  };
}

/** Dedicated identity gate: environment identity plus freshly validated session. */
export async function requireMasterAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const master = configuredMasterEmail();
  const email = req.session?.authenticatedEmail;
  if (!master || !email || normalizeEmail(email) !== master) {
    // Denials are auditable too. A failed audit means no access regardless.
    try {
      await platformAudit(
        req,
        "platform_admin.access",
        "platform",
        "platform",
        "denied",
      );
    } catch {
      // Access remains denied even when the audit store is unavailable.
    }
    res.status(403).json({ error: "Master administrator access required." });
    return;
  }
  next();
}