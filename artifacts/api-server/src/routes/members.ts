import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, membershipsTable, usersTable } from "@workspace/db";
import {
  ListMembersParams,
  ListMembersResponse,
  AddMemberParams,
  AddMemberBody,
  AddMemberResponse,
  RevokeMemberParams,
  RevokeMemberResponse,
  InviteAccountantParams,
  InviteAccountantBody,
  InviteAccountantResponse,
} from "@workspace/api-zod";
import {
  requirePermission,
  upsertUser,
  addMember as addMemberEntry,
  inviteAccountant as inviteAccountantEntry,
  revokeMember as revokeMemberEntry,
} from "@workspace/ledger";
import { sendLedgerError, ConflictError, HttpError } from "../lib/errors";
import { getSessionUserId } from "../middlewares/auth";
import {
  configuredMasterEmail,
  normalizeEmail,
} from "../lib/auth-service";

function assertNotReservedOperatorEmail(email: string): string {
  const normalized = normalizeEmail(email);
  if (normalized === configuredMasterEmail()) {
    throw new ConflictError(
      "That email is reserved for operator provisioning.",
    );
  }
  return normalized;
}

const router: IRouter = Router();

/** Shape a membership + its user into the API member view. */
async function memberView(orgId: string, userId: string) {
  const [row] = await db
    .select({
      userId: membershipsTable.userId,
      email: usersTable.email,
      name: usersTable.name,
      role: membershipsTable.role,
      revokedAt: membershipsTable.revokedAt,
    })
    .from(membershipsTable)
    .innerJoin(usersTable, eq(usersTable.id, membershipsTable.userId))
    .where(
      and(
        eq(membershipsTable.orgId, orgId),
        eq(membershipsTable.userId, userId),
      ),
    )
    .limit(1);
  if (!row) throw new HttpError(404, "Membership not found for org.");
  return {
    userId: row.userId,
    email: row.email,
    name: row.name,
    role: row.role,
    active: row.revokedAt === null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
  };
}

router.get("/orgs/:orgId/members", async (req, res) => {
  try {
    const userId = getSessionUserId(req);
    const { orgId } = ListMembersParams.parse(req.params);
    await requirePermission(orgId, userId, "reports.read");

    const rows = await db
      .select({
        userId: membershipsTable.userId,
        email: usersTable.email,
        name: usersTable.name,
        role: membershipsTable.role,
        revokedAt: membershipsTable.revokedAt,
      })
      .from(membershipsTable)
      .innerJoin(usersTable, eq(usersTable.id, membershipsTable.userId))
      .where(eq(membershipsTable.orgId, orgId))
      .orderBy(membershipsTable.createdAt);

    res.json(
      ListMembersResponse.parse({
        members: rows.map((r) => ({
          userId: r.userId,
          email: r.email,
          name: r.name,
          role: r.role,
          active: r.revokedAt === null,
          revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
        })),
      }),
    );
  } catch (err) {
    sendLedgerError(res, err);
  }
});

router.post("/orgs/:orgId/members", async (req, res) => {
  try {
    const actorId = getSessionUserId(req);
    const { orgId } = AddMemberParams.parse(req.params);
    const body = AddMemberBody.parse(req.body);
    await requirePermission(orgId, actorId, "members.manage");

    const user = await upsertUser(
      assertNotReservedOperatorEmail(body.email),
      body.name || undefined,
    );
    await addMemberEntry(orgId, user.id, body.role, {
      actor: actorId,
      invitedBy: actorId,
    });

    res.status(201).json(AddMemberResponse.parse(await memberView(orgId, user.id)));
  } catch (err) {
    sendLedgerError(res, err);
  }
});

router.post("/orgs/:orgId/members/:userId/revoke", async (req, res) => {
  try {
    const actorId = getSessionUserId(req);
    const { orgId, userId } = RevokeMemberParams.parse(req.params);
    await requirePermission(orgId, actorId, "members.manage");

    await revokeMemberEntry(orgId, userId, { actor: actorId });
    res.json(RevokeMemberResponse.parse(await memberView(orgId, userId)));
  } catch (err) {
    sendLedgerError(res, err);
  }
});

router.post("/orgs/:orgId/accountants", async (req, res) => {
  try {
    const actorId = getSessionUserId(req);
    const { orgId } = InviteAccountantParams.parse(req.params);
    const body = InviteAccountantBody.parse(req.body);
    await requirePermission(orgId, actorId, "members.manage");

    const user = await upsertUser(
      assertNotReservedOperatorEmail(body.email),
      body.name || undefined,
    );
    await inviteAccountantEntry(orgId, user.id, {
      actor: actorId,
      invitedBy: actorId,
    });

    res
      .status(201)
      .json(InviteAccountantResponse.parse(await memberView(orgId, user.id)));
  } catch (err) {
    sendLedgerError(res, err);
  }
});

export default router;
