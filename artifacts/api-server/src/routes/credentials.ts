import { Router, type IRouter } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { db, membershipsTable } from "@workspace/db";
import { z } from "zod";
import { getSessionUserId } from "../middlewares/auth";
import { safeAuditMachineCall, createMachineCredential, listMachineCredentials, revokeMachineCredential, rotateMachineCredential, MachineCredentialNotFoundError, MACHINE_SCOPES } from "../lib/machine-credentials";
import { sendLedgerError, HttpError } from "../lib/errors";

const params = z.object({ orgId: z.string().uuid() });
const credentialParams = params.extend({ credentialId: z.string().uuid() });
const body = z.object({
  name: z.string().trim().min(1).max(200),
  scopes: z.array(z.enum(MACHINE_SCOPES)).min(1),
  notes: z.string().max(2000).optional(),
});
const router: IRouter = Router();

async function requireOwner(orgId: string, userId: string): Promise<void> {
  const [membership] = await db.select().from(membershipsTable).where(and(
    eq(membershipsTable.orgId, orgId), eq(membershipsTable.userId, userId),
    eq(membershipsTable.role, "owner"), isNull(membershipsTable.revokedAt),
  )).limit(1);
  if (!membership) throw new HttpError(403, "Organization owner access required.");
}
function audit(req: { orgId: string; action: string; status: number; credentialId?: string; actorUserId?: string; details?: unknown; method?: string; path?: string }) {
  return safeAuditMachineCall({ ...req, method: req.method ?? "MANAGEMENT", path: req.path ?? "/credentials" });
}

router.get("/orgs/:orgId/credentials", async (req, res) => {
  try {
    const { orgId } = params.parse(req.params); const actor = getSessionUserId(req);
    await requireOwner(orgId, actor);
    const credentials = await listMachineCredentials(orgId);
    await audit({ orgId, actorUserId: actor, action: "credential.list", status: 200 });
    res.json({ credentials });
  } catch (err) { sendCredentialError(res, err); }
});

router.post("/orgs/:orgId/credentials", async (req, res) => {
  try {
    const { orgId } = params.parse(req.params); const actor = getSessionUserId(req);
    await requireOwner(orgId, actor);
    const result = await createMachineCredential(orgId, actor, body.parse(req.body));
    res.status(201).json(result);
  } catch (err) { sendCredentialError(res, err); }
});

router.delete("/orgs/:orgId/credentials/:credentialId", async (req, res) => {
  try {
    const { orgId, credentialId } = credentialParams.parse(req.params); const actor = getSessionUserId(req);
    await requireOwner(orgId, actor);
    const credential = await revokeMachineCredential(orgId, credentialId, actor);
    res.json({ credential });
  } catch (err) { sendCredentialError(res, err); }
});

router.post("/orgs/:orgId/credentials/:credentialId/rotate", async (req, res) => {
  try {
    const { orgId, credentialId } = credentialParams.parse(req.params); const actor = getSessionUserId(req);
    await requireOwner(orgId, actor);
    const result = await rotateMachineCredential(orgId, credentialId, actor);
    res.status(200).json(result);
  } catch (err) { sendCredentialError(res, err); }
});

function sendCredentialError(res: Parameters<typeof sendLedgerError>[0], err: unknown): void {
  if (err instanceof MachineCredentialNotFoundError) {
    res.status(404).json({ error: "Credential not found." });
    return;
  }
  sendLedgerError(res, err);
}

export default router;