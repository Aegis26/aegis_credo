import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import { and, asc, count, eq, isNull, sql } from "drizzle-orm";
import {
  CreatePlatformPasswordResetParams,
  CreatePlatformPasswordResetResponse,
  CreatePlatformUserBody,
  CreatePlatformUserResponse,
  DeactivatePlatformUserParams,
  DeactivatePlatformUserResponse,
  GetPlatformHealthResponse,
  GetPlatformUserStatusParams,
  GetPlatformUserStatusResponse,
  ListPlatformOrganizationsQueryParams,
  ListPlatformOrganizationsResponse,
  ListPlatformUsersQueryParams,
  ListPlatformUsersResponse,
  ReactivatePlatformUserParams,
  ReactivatePlatformUserResponse,
} from "@workspace/api-zod";
import {
  db,
  membershipsTable,
  organizationsTable,
  passwordResetTokensTable,
  platformAuditLogTable,
  usersTable,
} from "@workspace/db";
import { ConflictError, sendLedgerError } from "../lib/errors";
import {
  configuredMasterEmail,
  hashPassword,
  normalizeEmail,
} from "../lib/auth-service";
import {
  platformAudit,
  platformAuditValues,
} from "../middlewares/master-admin";
import { createPasswordReset } from "../lib/password-reset-service";

export interface PlatformAdminRouterOptions {
  resetRateLimitMax?: number;
}

const metadata = (user: typeof usersTable.$inferSelect) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  createdAt: user.createdAt,
  status: user.deactivatedAt ? "deactivated" : "active",
});

const status = (user: typeof usersTable.$inferSelect) => ({
  id: user.id,
  status: user.deactivatedAt ? "deactivated" : "active",
  loginAvailable:
    !user.deactivatedAt &&
    (!user.lockedUntil || user.lockedUntil <= new Date()),
  lockedUntil: user.lockedUntil,
});

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    if ((current as { code?: string }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export default function createPlatformAdminRouter(
  options: PlatformAdminRouterOptions = {},
): IRouter {
  const router: IRouter = Router();
  const configuredMax = Number(process.env.PLATFORM_RESET_RATE_LIMIT_MAX);
  const resetLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max:
      options.resetRateLimitMax ??
      (Number.isFinite(configuredMax) && configuredMax > 0
        ? configuredMax
        : 10),
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) =>
      res.status(429).json({ error: "Too many requests. Try again later." }),
  });

router.get("/users", async (req, res): Promise<void> => {
  try {
    const query = ListPlatformUsersQueryParams.parse(req.query);
    const users = await db
      .select()
      .from(usersTable)
      .orderBy(asc(usersTable.createdAt))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);
    await platformAudit(req, "platform_admin.users.list", "user", "*", "success");
    res.json(
      ListPlatformUsersResponse.parse({
        users: users.map(metadata),
        ...query,
      }),
    );
  } catch (error) {
    sendLedgerError(res, error);
  }
});

router.post("/users", async (req, res): Promise<void> => {
  try {
    const body = CreatePlatformUserBody.parse(req.body);
    const email = normalizeEmail(body.email);
    if (email === configuredMasterEmail()) {
      await platformAudit(
        req,
        "platform_admin.user.create",
        "user",
        "reserved-email",
        "denied",
        { reason: "reserved_operator_identity" },
      );
      throw new ConflictError("That email is reserved for CLI provisioning.");
    }
    const passwordHash = await hashPassword(body.password);
    const user = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(usersTable)
        .values({ email, name: body.name, passwordHash })
        .returning();
      await tx
        .insert(platformAuditLogTable)
        .values(
          platformAuditValues(
            req,
            "platform_admin.user.create",
            "user",
            created.id,
            "success",
          ),
        );
      return created;
    });
    res.status(201).json(CreatePlatformUserResponse.parse(metadata(user)));
  } catch (error) {
    if (isUniqueViolation(error)) {
      try {
        await platformAudit(
          req,
          "platform_admin.user.create",
          "user",
          "duplicate-email",
          "denied",
          { reason: "duplicate" },
        );
      } catch (auditError) {
        sendLedgerError(res, auditError);
        return;
      }
      sendLedgerError(res, new ConflictError("Email already registered."));
      return;
    }
    sendLedgerError(res, error);
  }
});

router.get("/users/:userId/status", async (req, res): Promise<void> => {
  try {
    const { userId } = GetPlatformUserStatusParams.parse(req.params);
    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, userId));
    if (!user) {
      await platformAudit(
        req,
        "platform_admin.user.status",
        "user",
        userId,
        "denied",
        { reason: "not_found" },
      );
      res.status(404).json({ error: "User not found." });
      return;
    }
    await platformAudit(req, "platform_admin.user.status", "user", userId, "success");
    res.json(GetPlatformUserStatusResponse.parse(status(user)));
  } catch (error) {
    sendLedgerError(res, error);
  }
});

router.post("/users/:userId/deactivate", async (req, res): Promise<void> => {
  try {
    const { userId } = DeactivatePlatformUserParams.parse(req.params);
    const [configuredMaster] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.email, configuredMasterEmail() ?? ""))
      .limit(1);
    if (userId === req.userId || userId === configuredMaster?.id) {
      await platformAudit(req, "platform_admin.user.deactivate", "user", userId, "denied");
      res
        .status(403)
        .json({ error: "Master administrator cannot be deactivated." });
      return;
    }
    const user = await db.transaction(async (tx) => {
      const deactivatedAt = new Date();
      const [updated] = await tx
        .update(usersTable)
        .set({
          deactivatedAt,
          sessionVersion: sql`${usersTable.sessionVersion} + 1`,
        })
        .where(eq(usersTable.id, userId))
        .returning();
      if (!updated) return undefined;
      await tx
        .update(passwordResetTokensTable)
        .set({ invalidatedAt: deactivatedAt })
        .where(
          and(
            eq(passwordResetTokensTable.userId, userId),
            isNull(passwordResetTokensTable.consumedAt),
            isNull(passwordResetTokensTable.invalidatedAt),
          ),
        );
      await tx
        .insert(platformAuditLogTable)
        .values(
          platformAuditValues(
            req,
            "platform_admin.user.deactivate",
            "user",
            userId,
            "success",
          ),
        );
      return updated;
    });
    if (!user) {
      await platformAudit(
        req,
        "platform_admin.user.deactivate",
        "user",
        userId,
        "denied",
        { reason: "not_found" },
      );
      res.status(404).json({ error: "User not found." });
      return;
    }
    res.json(DeactivatePlatformUserResponse.parse(status(user)));
  } catch (error) {
    sendLedgerError(res, error);
  }
});

router.post("/users/:userId/reactivate", async (req, res): Promise<void> => {
  try {
    const { userId } = ReactivatePlatformUserParams.parse(req.params);
    const user = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(usersTable)
        .set({
          deactivatedAt: null,
          sessionVersion: sql`${usersTable.sessionVersion} + 1`,
        })
        .where(eq(usersTable.id, userId))
        .returning();
      if (!updated) return undefined;
      await tx
        .insert(platformAuditLogTable)
        .values(
          platformAuditValues(
            req,
            "platform_admin.user.reactivate",
            "user",
            userId,
            "success",
          ),
        );
      return updated;
    });
    if (!user) {
      await platformAudit(
        req,
        "platform_admin.user.reactivate",
        "user",
        userId,
        "denied",
        { reason: "not_found" },
      );
      res.status(404).json({ error: "User not found." });
      return;
    }
    res.json(ReactivatePlatformUserResponse.parse(status(user)));
  } catch (error) {
    sendLedgerError(res, error);
  }
});

router.post("/users/:userId/password-reset", resetLimiter, async (req, res): Promise<void> => {
  try {
    const { userId } = CreatePlatformPasswordResetParams.parse(req.params);
    const link = await createPasswordReset(userId, {
      actorUserId: req.userId!,
      requestId: typeof req.id === "string" ? req.id : null,
    });
    if (!link) {
      res.status(404).json({ error: "User not found." });
      return;
    }
    res.json(CreatePlatformPasswordResetResponse.parse({ resetLink: link }));
  } catch (error) {
    sendLedgerError(res, error);
  }
});

router.get("/organizations", async (req, res): Promise<void> => {
  try {
    const query = ListPlatformOrganizationsQueryParams.parse(req.query);
    const orgs = await db
      .select()
      .from(organizationsTable)
      .orderBy(asc(organizationsTable.createdAt))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);
    const result = await Promise.all(
      orgs.map(async (organization) => {
        const rows = await db
          .select({ user: usersTable, role: membershipsTable.role })
          .from(membershipsTable)
          .innerJoin(usersTable, eq(membershipsTable.userId, usersTable.id))
          .where(
            and(
              eq(membershipsTable.orgId, organization.id),
              isNull(membershipsTable.revokedAt),
            ),
          );
        return {
          id: organization.id,
          name: organization.name,
          createdAt: organization.createdAt,
          owners: rows
            .filter(
              (row) => row.role === "owner" && !row.user.deactivatedAt,
            )
            .map((row) => metadata(row.user)),
          activeMemberCount: rows.filter((row) => !row.user.deactivatedAt)
            .length,
        };
      }),
    );
    await platformAudit(req, "platform_admin.organizations.list", "organization", "*", "success");
    res.json(
      ListPlatformOrganizationsResponse.parse({
        organizations: result,
        ...query,
      }),
    );
  } catch (error) {
    sendLedgerError(res, error);
  }
});

router.get("/health", async (req, res): Promise<void> => {
  try {
    const [[users], [organizations]] = await Promise.all([
      db.select({ value: count() }).from(usersTable),
      db.select({ value: count() }).from(organizationsTable),
    ]);
    await platformAudit(req, "platform_admin.health.read", "platform", "platform", "success");
    res.json(
      GetPlatformHealthResponse.parse({
        database: "ok",
        userCount: users.value,
        organizationCount: organizations.value,
      }),
    );
  } catch (error) {
    sendLedgerError(res, error);
  }
});

  return router;
}