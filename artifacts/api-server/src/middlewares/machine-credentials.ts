import type { Request, Response, NextFunction } from "express";
import { safeAuditMachineCall, authenticateMachineKey, type MachineScope } from "../lib/machine-credentials";

/** Exported for the app's origin middleware integration: bearer requests are
 * server-to-server and may bypass CSRF origin checks only after this succeeds. */
export function hasMachineBearer(req: Request): boolean {
  return typeof req.headers.authorization === "string" &&
    req.headers.authorization.startsWith("Bearer ");
}

export async function requireMachineCredential(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Invalid bearer attempts are audited, but the API's existing global
  // rate-limit middleware must remain in front of this middleware to bound
  // unauthenticated database writes.
  if (!hasMachineBearer(req)) {
    await safeAuditMachineCall({ action: "auth.denied", method: req.method, path: req.path, status: 401 });
    res.status(401).json({ error: "Machine credential required." });
    return;
  }
  const principal = await authenticateMachineKey(req.headers.authorization!.slice(7).trim());
  if (!principal) {
    await safeAuditMachineCall({ action: "auth.denied", method: req.method, path: req.path, status: 401 });
    res.status(401).json({ error: "Invalid machine credential." });
    return;
  }
  req.machinePrincipal = principal;
  req.machine = principal;
  // The finish hook covers successful calls and authorization failures in
  // downstream middleware, without ever recording the bearer value.
  res.once("finish", () => {
    void safeAuditMachineCall({
      orgId: principal.orgId, credentialId: principal.credentialId,
      action: "machine.call", method: req.method, path: req.path, status: res.statusCode,
    });
  });
  next();
}

export function requireMachineOrg(orgParam = "orgId") {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const principal = req.machinePrincipal;
    if (!principal) { res.status(401).json({ error: "Machine credential required." }); return; }
    if (req.params[orgParam] !== principal.orgId) {
      res.status(403).json({ error: "Credential is not valid for this organization." });
      return;
    }
    next();
  };
}

export function requireMachineScope(scope: MachineScope) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const principal = req.machinePrincipal;
    if (!principal || !principal.scopes.includes(scope)) {
      res.status(403).json({ error: "Credential lacks the required scope." });
      return;
    }
    next();
  };
}