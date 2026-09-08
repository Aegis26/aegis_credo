import crypto from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import {
  db,
  passwordResetTokensTable,
  platformAuditLogTable,
  usersTable,
} from "@workspace/db";
import { hashPassword } from "./auth-service";

const hash = (token: string) =>
  crypto.createHash("sha256").update(token).digest("hex");
const publicUrl = (): string => {
  const raw = process.env.PUBLIC_APP_URL;
  // The Books artifact is mounted at root. Railway/production may set the
  // portable PUBLIC_APP_URL when the public application has an absolute URL.
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString().replace(/\/$/, "")
      : "";
  } catch {
    return "";
  }
};

export interface PasswordResetAuditContext {
  actorUserId: string;
  requestId?: string | null;
}

/** Delivery seam: replace only this function when transactional email is added. */
export async function sendPasswordResetLink(resetLink: string): Promise<string> {
  return resetLink;
}

/**
 * Invalidate old tokens, create the new hash-only token, and write the admin
 * audit row in one transaction. The raw token exists in process memory only.
 */
export async function createPasswordReset(
  userId: string,
  audit: PasswordResetAuditContext,
): Promise<string | undefined> {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = new Date();
  const created = await db.transaction(async (tx) => {
    const [user] = await tx
      .select({
        id: usersTable.id,
        deactivatedAt: usersTable.deactivatedAt,
      })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1)
      .for("update");
    if (!user) {
      await tx.insert(platformAuditLogTable).values({
        actorUserId: audit.actorUserId,
        action: "platform_admin.password_reset.create",
        entity: "user",
        entityId: userId,
        outcome: "denied",
        requestId: audit.requestId ?? null,
        detail: { reason: "not_found" },
      });
      return false;
    }
    if (user.deactivatedAt) {
      await tx.insert(platformAuditLogTable).values({
        actorUserId: audit.actorUserId,
        action: "platform_admin.password_reset.create",
        entity: "user",
        entityId: userId,
        outcome: "denied",
        requestId: audit.requestId ?? null,
        detail: { reason: "deactivated" },
      });
      return false;
    }
    await tx
      .update(passwordResetTokensTable)
      .set({ invalidatedAt: now })
      .where(
        and(
          eq(passwordResetTokensTable.userId, userId),
          isNull(passwordResetTokensTable.consumedAt),
          isNull(passwordResetTokensTable.invalidatedAt),
        ),
      );
    await tx.insert(passwordResetTokensTable).values({
      userId,
      tokenHash: hash(token),
      expiresAt: new Date(now.getTime() + 30 * 60 * 1000),
    });
    await tx.insert(platformAuditLogTable).values({
      actorUserId: audit.actorUserId,
      action: "platform_admin.password_reset.create",
      entity: "user",
      entityId: userId,
      outcome: "success",
      requestId: audit.requestId ?? null,
      detail: null,
    });
    return true;
  });
  if (!created) return undefined;
  const link = `${publicUrl()}/reset-password?token=${encodeURIComponent(token)}`;
  return sendPasswordResetLink(link);
}

export async function completePasswordReset(
  token: string,
  newPassword: string,
): Promise<boolean> {
  const tokenHash = hash(token);
  const now = new Date();
  const passwordHash = await hashPassword(newPassword);
  return db.transaction(async (tx) => {
    // Find the candidate first, then serialize every reset/deactivation action
    // on the user row. We re-check and lock the token after acquiring that
    // lock so concurrent issuance/consumption cannot make a stale token valid.
    const [candidate] = await tx
      .select()
      .from(passwordResetTokensTable)
      .where(
        and(
          eq(passwordResetTokensTable.tokenHash, tokenHash),
          isNull(passwordResetTokensTable.consumedAt),
          isNull(passwordResetTokensTable.invalidatedAt),
          gt(passwordResetTokensTable.expiresAt, now),
        ),
      )
      .limit(1);
    if (!candidate) {
      await tx.insert(platformAuditLogTable).values({
        actorUserId: null,
        action: "password_reset.complete",
        entity: "password_reset",
        entityId: "unknown",
        outcome: "denied",
        detail: null,
      });
      return false;
    }

    const [activeUser] = await tx
      .select({
        id: usersTable.id,
        deactivatedAt: usersTable.deactivatedAt,
      })
      .from(usersTable)
      .where(eq(usersTable.id, candidate.userId))
      .for("update");
    if (!activeUser || activeUser.deactivatedAt) {
      const validationNow = new Date();
      await tx
        .update(passwordResetTokensTable)
        .set({ invalidatedAt: validationNow })
        .where(eq(passwordResetTokensTable.id, candidate.id));
      await tx.insert(platformAuditLogTable).values({
        actorUserId: activeUser?.id ?? null,
        action: "password_reset.complete",
        entity: "user",
        entityId: candidate.userId,
        outcome: "denied",
        detail: { reason: "deactivated_or_missing" },
      });
      return false;
    }

    const validationNow = new Date();
    const [row] = await tx
      .select()
      .from(passwordResetTokensTable)
      .where(
        and(
          eq(passwordResetTokensTable.id, candidate.id),
          isNull(passwordResetTokensTable.consumedAt),
          isNull(passwordResetTokensTable.invalidatedAt),
          gt(passwordResetTokensTable.expiresAt, validationNow),
        ),
      )
      .for("update");
    if (!row) {
      await tx.insert(platformAuditLogTable).values({
        actorUserId: null,
        action: "password_reset.complete",
        entity: "password_reset",
        entityId: "unknown",
        outcome: "denied",
        detail: null,
      });
      return false;
    }

    const [user] = await tx
      .update(usersTable)
      .set({
        passwordHash,
        sessionVersion: sql`${usersTable.sessionVersion} + 1`,
      })
      .where(eq(usersTable.id, row.userId))
      .returning();
    await tx
      .update(passwordResetTokensTable)
      .set({ consumedAt: validationNow })
      .where(eq(passwordResetTokensTable.id, row.id));
    await tx.insert(platformAuditLogTable).values({
      actorUserId: user.id,
      action: "password_reset.complete",
      entity: "user",
      entityId: user.id,
      outcome: "success",
      detail: null,
    });
    return true;
  });
}