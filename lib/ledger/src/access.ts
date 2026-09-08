import { and, eq, isNull, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  membershipsTable,
  auditLogTable,
  type User,
  type Membership,
  type MembershipRole,
} from "@workspace/db";
import { ForbiddenError, NotFoundError } from "./errors";
import { serializeForAudit } from "./audit";

/**
 * Actions that can be gated by role. Every money-moving or administrative
 * operation should check one of these before proceeding — the ledger core
 * itself performs no auth, so callers must gate access here.
 */
export type Permission =
  | "ledger.post" // create journal entries, bills, invoices, payroll, imports
  | "ledger.reverse" // reverse a posted entry
  | "reports.read" // read balances and financial reports
  | "members.manage" // invite/revoke members and accountants
  | "coa.manage"; // alter the chart of accounts (create accounts)

// Role -> allowed permissions. "accountant" is the external-collaborator role:
// read-only reporting access, granted per-org and revocable.
const ROLE_PERMISSIONS: Record<MembershipRole, ReadonlySet<Permission>> = {
  owner: new Set<Permission>([
    "ledger.post",
    "ledger.reverse",
    "reports.read",
    "members.manage",
    "coa.manage",
  ]),
  staff: new Set<Permission>(["ledger.post", "ledger.reverse", "reports.read"]),
  view_only: new Set<Permission>(["reports.read"]),
  accountant: new Set<Permission>(["reports.read"]),
};

/** Create (or return existing) user by email. Email is globally unique. */
export async function upsertUser(email: string, name?: string): Promise<User> {
  const normalizedEmail = email.trim().toLowerCase();
  const [created] = await db
    .insert(usersTable)
    .values({ email: normalizedEmail, name })
    .onConflictDoNothing()
    .returning();
  if (created) return created;

  // The normalized unique index makes concurrent/case-variant invitations
  // converge on one identity.
  const [existing] = await db
    .select()
    .from(usersTable)
    .where(sql`lower(${usersTable.email}) = ${normalizedEmail}`)
    .limit(1);
  if (!existing) throw new Error("User upsert conflict could not be resolved.");
  return existing;
}

export interface AddMemberOptions {
  actor?: string;
  invitedBy?: string;
}

/**
 * Grant a user a role in an org (or reactivate/update an existing membership).
 * Fully audit-logged. Scoped strictly to the given org.
 */
export async function addMember(
  orgId: string,
  userId: string,
  role: MembershipRole,
  options: AddMemberOptions = {},
): Promise<Membership> {
  const actor = options.actor ?? "system";
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(membershipsTable)
      .where(
        and(
          eq(membershipsTable.orgId, orgId),
          eq(membershipsTable.userId, userId),
        ),
      )
      .limit(1);

    let membership: Membership;
    if (existing) {
      // Reactivate / change role on the existing membership row.
      [membership] = await tx
        .update(membershipsTable)
        .set({ role, revokedAt: null, invitedBy: options.invitedBy })
        .where(eq(membershipsTable.id, existing.id))
        .returning();
    } else {
      [membership] = await tx
        .insert(membershipsTable)
        .values({ orgId, userId, role, invitedBy: options.invitedBy })
        .returning();
    }

    await tx.insert(auditLogTable).values({
      orgId,
      actor,
      action: existing ? "member.update" : "member.add",
      entity: "membership",
      entityId: membership.id,
      before: existing ? serializeForAudit(existing) : null,
      after: serializeForAudit(membership),
    });

    return membership;
  });
}

/**
 * Invite an external accountant into an org with scoped, revocable access.
 * Thin wrapper over addMember with the "accountant" role.
 */
export async function inviteAccountant(
  orgId: string,
  userId: string,
  options: AddMemberOptions = {},
): Promise<Membership> {
  return addMember(orgId, userId, "accountant", options);
}

/** Revoke a member's (or accountant's) access. Append-only: sets revokedAt. */
export async function revokeMember(
  orgId: string,
  userId: string,
  options: { actor?: string } = {},
): Promise<Membership> {
  const actor = options.actor ?? "system";
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(membershipsTable)
      .where(
        and(
          eq(membershipsTable.orgId, orgId),
          eq(membershipsTable.userId, userId),
        ),
      )
      .limit(1);
    if (!existing) {
      throw new NotFoundError("Membership not found for org.");
    }

    const [membership] = await tx
      .update(membershipsTable)
      .set({ revokedAt: new Date() })
      .where(eq(membershipsTable.id, existing.id))
      .returning();

    await tx.insert(auditLogTable).values({
      orgId,
      actor,
      action: "member.revoke",
      entity: "membership",
      entityId: membership.id,
      before: serializeForAudit(existing),
      after: serializeForAudit(membership),
    });

    return membership;
  });
}

/** Return the active (non-revoked) membership for a user in an org, if any. */
export async function getActiveMembership(
  orgId: string,
  userId: string,
): Promise<Membership | undefined> {
  const [membership] = await db
    .select()
    .from(membershipsTable)
    .where(
      and(
        eq(membershipsTable.orgId, orgId),
        eq(membershipsTable.userId, userId),
        isNull(membershipsTable.revokedAt),
      ),
    )
    .limit(1);
  return membership;
}

/** The set of org ids a user currently has active access to. */
export async function listOrgsForUser(userId: string): Promise<string[]> {
  const rows = await db
    .select({ orgId: membershipsTable.orgId })
    .from(membershipsTable)
    .where(
      and(
        eq(membershipsTable.userId, userId),
        isNull(membershipsTable.revokedAt),
      ),
    );
  return rows.map((r) => r.orgId);
}

/** True if the user has an active membership whose role allows the action. */
export async function can(
  orgId: string,
  userId: string,
  permission: Permission,
): Promise<boolean> {
  const membership = await getActiveMembership(orgId, userId);
  if (!membership) return false;
  return ROLE_PERMISSIONS[membership.role].has(permission);
}

/**
 * Assert the user may perform the action in the org, throwing ForbiddenError
 * otherwise. Use this to gate every operation before touching the ledger.
 */
export async function requirePermission(
  orgId: string,
  userId: string,
  permission: Permission,
): Promise<void> {
  if (!(await can(orgId, userId, permission))) {
    throw new ForbiddenError(
      `User ${userId} lacks permission "${permission}" in org ${orgId}.`,
    );
  }
}
