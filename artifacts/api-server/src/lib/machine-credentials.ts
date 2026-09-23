import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db, machineCredentialsTable, machineAuditTable, type MachineCredential } from "@workspace/db";
import { logger } from "./logger";

export const MACHINE_SCOPES = [
  "read:invoices", "write:invoices", "read:gl", "write:gl",
  "read:reports", "read:customers",
] as const;
export type MachineScope = (typeof MACHINE_SCOPES)[number];
const PREFIX = "credo_sk_live_";
export class MachineCredentialNotFoundError extends Error {}

export interface CredentialInput { name: string; scopes: MachineScope[]; notes?: string }
export interface CredentialView {
  id: string; name: string; scopes: MachineScope[]; createdAt: string;
  lastUsedAt: string | null; revokedAt: string | null; isActive: boolean; notes: string | null;
}
export interface MachinePrincipal { credentialId: string; orgId: string; scopes: MachineScope[] }

function hashKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}
function view(row: MachineCredential): CredentialView {
  return {
    id: row.id, name: row.name, scopes: row.scopes as MachineScope[],
    createdAt: row.createdAt.toISOString(), lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null, isActive: row.isActive && row.revokedAt === null, notes: row.notes,
  };
}
function newKey(): string { return PREFIX + randomBytes(32).toString("base64url"); }

export async function listMachineCredentials(orgId: string): Promise<CredentialView[]> {
  const rows = await db.select().from(machineCredentialsTable)
    .where(eq(machineCredentialsTable.orgId, orgId))
    .orderBy(machineCredentialsTable.createdAt);
  return rows.map(view);
}

export async function createMachineCredential(
  orgId: string, createdBy: string, input: CredentialInput,
): Promise<{ credential: CredentialView; apiKey: string }> {
  const apiKey = newKey();
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(machineCredentialsTable).values({
      orgId, createdBy, name: input.name, scopes: input.scopes, notes: input.notes ?? null, keyHash: hashKey(apiKey),
    }).returning();
    await tx.insert(machineAuditTable).values({
      orgId, credentialId: row.id, actorUserId: createdBy, action: "credential.create",
      method: "POST", path: `/api/orgs/${orgId}/credentials`, status: "201",
      details: { scopes: input.scopes },
    });
    return { credential: view(row), apiKey };
  });
}

export async function revokeMachineCredential(orgId: string, credentialId: string, actorUserId: string): Promise<CredentialView> {
  return db.transaction(async (tx) => {
    const [row] = await tx.update(machineCredentialsTable)
      .set({ revokedAt: new Date(), isActive: false })
      .where(and(eq(machineCredentialsTable.id, credentialId), eq(machineCredentialsTable.orgId, orgId), eq(machineCredentialsTable.isActive, true), isNull(machineCredentialsTable.revokedAt)))
      .returning();
    if (!row) throw new MachineCredentialNotFoundError("Credential not found or already revoked.");
    await tx.insert(machineAuditTable).values({
      orgId, credentialId: row.id, actorUserId, action: "credential.revoke",
      method: "DELETE", path: `/api/orgs/${orgId}/credentials/${credentialId}`, status: "200",
      details: { scopes: row.scopes },
    });
    return view(row);
  });
}

export async function rotateMachineCredential(
  orgId: string, credentialId: string, createdBy: string,
): Promise<{ credential: CredentialView; apiKey: string }> {
  const apiKey = newKey();
  return db.transaction(async (tx) => {
    const [old] = await tx.update(machineCredentialsTable)
      .set({ revokedAt: new Date(), isActive: false })
      .where(and(eq(machineCredentialsTable.id, credentialId), eq(machineCredentialsTable.orgId, orgId), eq(machineCredentialsTable.isActive, true), isNull(machineCredentialsTable.revokedAt)))
      .returning();
    if (!old) throw new MachineCredentialNotFoundError("Credential not found or already revoked.");
    const [row] = await tx.insert(machineCredentialsTable).values({
      orgId, createdBy, name: old.name, scopes: old.scopes, notes: old.notes, keyHash: hashKey(apiKey),
    }).returning();
    await tx.insert(machineAuditTable).values({
      orgId, credentialId: row.id, actorUserId: createdBy, action: "credential.rotate",
      method: "POST", path: `/api/orgs/${orgId}/credentials/${credentialId}/rotate`, status: "200",
      details: { scopes: row.scopes, oldCredentialId: old.id, newCredentialId: row.id },
    });
    return { credential: view(row), apiKey };
  });
}

/** Authenticate a bearer key. The raw key is never persisted or logged. */
export async function authenticateMachineKey(apiKey: string): Promise<MachinePrincipal | null> {
  if (!apiKey.startsWith(PREFIX)) return null;
  const hash = hashKey(apiKey);
  const [row] = await db.select().from(machineCredentialsTable)
    .where(and(eq(machineCredentialsTable.keyHash, hash), eq(machineCredentialsTable.isActive, true), isNull(machineCredentialsTable.revokedAt))).limit(1);
  if (!row) return null;
  // Recheck active state on the write, so a revoke racing the lookup cannot
  // authenticate a key that was revoked before the request proceeded.
  const [stillActive] = await db.update(machineCredentialsTable)
    .set({ lastUsedAt: new Date() })
    .where(and(eq(machineCredentialsTable.id, row.id), eq(machineCredentialsTable.isActive, true), isNull(machineCredentialsTable.revokedAt)))
    .returning({ id: machineCredentialsTable.id });
  if (!stillActive) return null;
  return { credentialId: row.id, orgId: row.orgId, scopes: row.scopes as MachineScope[] };
}

export async function auditMachineCall(input: {
  orgId?: string; credentialId?: string; actorUserId?: string; action: string; method: string; path: string; status: number; details?: unknown;
}): Promise<void> {
  await db.insert(machineAuditTable).values({
    orgId: input.orgId ?? null, credentialId: input.credentialId ?? null, actorUserId: input.actorUserId ?? null, action: input.action,
    method: input.method, path: input.path.split("?")[0], status: String(input.status), details: input.details ?? null,
  });
}

/** Audit persistence must never turn a completed credential mutation into a
 * misleading 500 (or expose a driver error). Callers retain the mutation/key. */
export async function safeAuditMachineCall(input: Parameters<typeof auditMachineCall>[0]): Promise<void> {
  try {
    await auditMachineCall(input);
  } catch (error) {
    logger.error({ errorName: error instanceof Error ? error.name : "UnknownError" }, "Machine audit write failed");
  }
}

export { view as credentialView };