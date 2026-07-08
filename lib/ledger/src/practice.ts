import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  db,
  practicesTable,
  practiceMembersTable,
  practiceClientsTable,
  organizationsTable,
  auditLogTable,
  type Practice,
  type PracticeMember,
  type PracticeClient,
  type PracticeRole,
  type Organization,
} from "@workspace/db";
import { ForbiddenError, NotFoundError } from "./errors";
import { serializeForAudit } from "./audit";

/**
 * The accountant / practice layer sits ON TOP of independent client books. A
 * practice never touches a client's ledger directly — it is an access,
 * collaboration, and reporting layer.
 *
 * Access model (two independent, revocable gates):
 *   1. practice_members  — is this user allowed to act as the practice at all?
 *   2. practice_clients  — which client orgs has the practice been granted?
 * A user sees a client iff they have an ACTIVE membership in a practice that
 * has an ACTIVE grant to that client. Revoking either gate hides the client.
 *
 * The per-client grant is THE audited access boundary: grant, revoke, and
 * explicit client access ("switch") are all audit-logged against the client org.
 */

/** Create a practice / firm. */
export async function createPractice(
  name: string,
): Promise<Practice> {
  const [practice] = await db
    .insert(practicesTable)
    .values({ name })
    .returning();
  return practice;
}

export interface AddPracticeMemberOptions {
  role?: PracticeRole;
}

/**
 * Add (or reactivate) a user as a member of the practice. Reactivating clears a
 * prior revocation. Membership alone grants NO client access.
 */
export async function addPracticeMember(
  practiceId: string,
  userId: string,
  options: AddPracticeMemberOptions = {},
): Promise<PracticeMember> {
  const role = options.role ?? "staff";
  const [existing] = await db
    .select()
    .from(practiceMembersTable)
    .where(
      and(
        eq(practiceMembersTable.practiceId, practiceId),
        eq(practiceMembersTable.userId, userId),
      ),
    )
    .limit(1);

  if (existing) {
    const [member] = await db
      .update(practiceMembersTable)
      .set({ role, revokedAt: null })
      .where(eq(practiceMembersTable.id, existing.id))
      .returning();
    return member;
  }
  const [member] = await db
    .insert(practiceMembersTable)
    .values({ practiceId, userId, role })
    .returning();
  return member;
}

/** Revoke a user's practice membership (append-only: sets revokedAt). */
export async function revokePracticeMember(
  practiceId: string,
  userId: string,
): Promise<PracticeMember> {
  const [existing] = await db
    .select()
    .from(practiceMembersTable)
    .where(
      and(
        eq(practiceMembersTable.practiceId, practiceId),
        eq(practiceMembersTable.userId, userId),
      ),
    )
    .limit(1);
  if (!existing) {
    throw new NotFoundError("Practice membership not found.");
  }
  const [member] = await db
    .update(practiceMembersTable)
    .set({ revokedAt: new Date() })
    .where(eq(practiceMembersTable.id, existing.id))
    .returning();
  return member;
}

export interface GrantClientAccessOptions {
  actor?: string;
  grantedBy?: string;
}

/**
 * Grant a practice access to a client org (or reactivate a revoked grant).
 * Audit-logged against the client org — this is the access boundary that
 * controls which clients a practice user can ever see.
 */
export async function grantClientAccess(
  practiceId: string,
  orgId: string,
  options: GrantClientAccessOptions = {},
): Promise<PracticeClient> {
  const actor = options.actor ?? "system";
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(practiceClientsTable)
      .where(
        and(
          eq(practiceClientsTable.practiceId, practiceId),
          eq(practiceClientsTable.orgId, orgId),
        ),
      )
      .limit(1);

    let grant: PracticeClient;
    if (existing) {
      [grant] = await tx
        .update(practiceClientsTable)
        .set({ revokedAt: null, grantedBy: options.grantedBy })
        .where(eq(practiceClientsTable.id, existing.id))
        .returning();
    } else {
      [grant] = await tx
        .insert(practiceClientsTable)
        .values({ practiceId, orgId, grantedBy: options.grantedBy })
        .returning();
    }

    await tx.insert(auditLogTable).values({
      orgId,
      actor,
      action: existing ? "practice.client.regrant" : "practice.client.grant",
      entity: "practice_client",
      entityId: grant.id,
      before: existing ? serializeForAudit(existing) : null,
      after: serializeForAudit(grant),
    });

    return grant;
  });
}

/** Revoke a practice's access to a client org (append-only). Audit-logged. */
export async function revokeClientAccess(
  practiceId: string,
  orgId: string,
  options: { actor?: string } = {},
): Promise<PracticeClient> {
  const actor = options.actor ?? "system";
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(practiceClientsTable)
      .where(
        and(
          eq(practiceClientsTable.practiceId, practiceId),
          eq(practiceClientsTable.orgId, orgId),
        ),
      )
      .limit(1);
    if (!existing) {
      throw new NotFoundError("Client access grant not found.");
    }

    const [grant] = await tx
      .update(practiceClientsTable)
      .set({ revokedAt: new Date() })
      .where(eq(practiceClientsTable.id, existing.id))
      .returning();

    await tx.insert(auditLogTable).values({
      orgId,
      actor,
      action: "practice.client.revoke",
      entity: "practice_client",
      entityId: grant.id,
      before: serializeForAudit(existing),
      after: serializeForAudit(grant),
    });

    return grant;
  });
}

/** Practice ids the user is an active member of. */
export async function listPracticesForUser(
  userId: string,
): Promise<string[]> {
  const rows = await db
    .select({ practiceId: practiceMembersTable.practiceId })
    .from(practiceMembersTable)
    .where(
      and(
        eq(practiceMembersTable.userId, userId),
        isNull(practiceMembersTable.revokedAt),
      ),
    );
  return rows.map((r) => r.practiceId);
}

/** Active client orgs granted to a practice (id + name). */
export async function listClientsForPractice(
  practiceId: string,
): Promise<Array<{ orgId: string; name: string }>> {
  const rows = await db
    .select({
      orgId: organizationsTable.id,
      name: organizationsTable.name,
    })
    .from(practiceClientsTable)
    .innerJoin(
      organizationsTable,
      eq(practiceClientsTable.orgId, organizationsTable.id),
    )
    .where(
      and(
        eq(practiceClientsTable.practiceId, practiceId),
        isNull(practiceClientsTable.revokedAt),
      ),
    )
    .orderBy(organizationsTable.name);
  return rows;
}

export interface ClientRef {
  orgId: string;
  name: string;
  practiceId: string;
}

/**
 * The client list / switcher for a practice user: every client the user can
 * reach via any active membership + active grant. Returns only granted clients,
 * so a user never sees a client they weren't explicitly granted.
 */
export async function listClientsForPracticeUser(
  userId: string,
): Promise<ClientRef[]> {
  const rows = await db
    .select({
      orgId: organizationsTable.id,
      name: organizationsTable.name,
      practiceId: practiceClientsTable.practiceId,
    })
    .from(practiceMembersTable)
    .innerJoin(
      practiceClientsTable,
      eq(practiceClientsTable.practiceId, practiceMembersTable.practiceId),
    )
    .innerJoin(
      organizationsTable,
      eq(practiceClientsTable.orgId, organizationsTable.id),
    )
    .where(
      and(
        eq(practiceMembersTable.userId, userId),
        isNull(practiceMembersTable.revokedAt),
        isNull(practiceClientsTable.revokedAt),
      ),
    )
    .orderBy(organizationsTable.name);

  // Distinct by orgId (a user could reach the same client via two practices).
  const seen = new Set<string>();
  const out: ClientRef[] = [];
  for (const r of rows) {
    if (seen.has(r.orgId)) continue;
    seen.add(r.orgId);
    out.push(r);
  }
  return out;
}

/** True when the user has active access to the client org. */
export async function hasClientAccess(
  userId: string,
  orgId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ orgId: practiceClientsTable.orgId })
    .from(practiceMembersTable)
    .innerJoin(
      practiceClientsTable,
      eq(practiceClientsTable.practiceId, practiceMembersTable.practiceId),
    )
    .where(
      and(
        eq(practiceMembersTable.userId, userId),
        eq(practiceClientsTable.orgId, orgId),
        isNull(practiceMembersTable.revokedAt),
        isNull(practiceClientsTable.revokedAt),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Assert the user may access the client org, throwing ForbiddenError otherwise.
 * Every practice-layer read/action must gate on this before touching a client's
 * books — the ledger core performs no auth.
 */
export async function assertClientAccess(
  userId: string,
  orgId: string,
): Promise<void> {
  if (!(await hasClientAccess(userId, orgId))) {
    throw new ForbiddenError(
      `User ${userId} has no granted access to client ${orgId}.`,
    );
  }
}

/** Restrict a requested set of client orgs to the ones the user may access. */
export async function accessibleClients(
  userId: string,
  orgIds: string[],
): Promise<string[]> {
  if (orgIds.length === 0) return [];
  const rows = await db
    .select({ orgId: practiceClientsTable.orgId })
    .from(practiceMembersTable)
    .innerJoin(
      practiceClientsTable,
      eq(practiceClientsTable.practiceId, practiceMembersTable.practiceId),
    )
    .where(
      and(
        eq(practiceMembersTable.userId, userId),
        inArray(practiceClientsTable.orgId, orgIds),
        isNull(practiceMembersTable.revokedAt),
        isNull(practiceClientsTable.revokedAt),
      ),
    );
  return [...new Set(rows.map((r) => r.orgId))];
}

/**
 * "Switch" a practice user into a client: assert access, audit the access event
 * against the client org, and return the client organization. This is the
 * explicit, audited entry point the switcher uses before showing client data.
 */
export async function switchToClient(
  userId: string,
  orgId: string,
  options: { actor?: string } = {},
): Promise<Organization> {
  await assertClientAccess(userId, orgId);
  const actor = options.actor ?? userId;
  return db.transaction(async (tx) => {
    const [org] = await tx
      .select()
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId))
      .limit(1);
    if (!org) throw new NotFoundError(`Organization ${orgId} not found.`);

    await tx.insert(auditLogTable).values({
      orgId,
      actor,
      action: "practice.client.access",
      entity: "organization",
      entityId: orgId,
      before: null,
      after: serializeForAudit({ userId, at: new Date().toISOString() }),
    });

    return org;
  });
}
