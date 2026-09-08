import crypto from "node:crypto";
import { Writable } from "node:stream";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { and, eq, isNull } from "drizzle-orm";
import {
  db,
  membershipsTable,
  passwordResetTokensTable,
  platformAuditLogTable,
  pool,
  sessionTable,
  usersTable,
} from "@workspace/db";
import { createApp } from "./app";
import { signup as provisionUser } from "./lib/auth-service";

const nonce = Date.now().toString(36);
const password = "correct-horse-battery";
const newPassword = "new-password-123";
const masterEmail = `master.${nonce}@example.test`;
const normalEmail = `normal.${nonce}@example.test`;
process.env.ALLOW_PUBLIC_SIGNUP = "true";
process.env.MASTER_ADMIN_EMAIL = masterEmail;
const app = createApp({
  authRateLimitMax: 100,
  platformResetRateLimitMax: 20,
});

async function signup(agent: request.Agent, email: string) {
  const response = await agent.post("/api/auth/signup").send({ email, password });
  expect(response.status).toBe(201);
  return response.body.user.id as string;
}

async function loginMaster(appAgent = request.agent(app)) {
  const response = await appAgent
    .post("/api/auth/login")
    .send({ email: masterEmail, password });
  expect(response.status).toBe(200);
  return appAgent;
}

function resetToken(resetLink: string): string {
  return new URL(resetLink, "http://local").searchParams.get("token")!;
}

function tokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

beforeAll(async () => {
  await provisionUser({
    email: masterEmail,
    password,
    name: "Platform Operator",
    ip: "test-cli",
    allowConfiguredMasterEmail: true,
  });
});

afterAll(async () => {
  await pool.end();
});

describe("platform admin boundary", () => {
  it("uses only configured session identity, fail-closes, and audits reads/denials", async () => {
    const master = await loginMaster();
    const ordinary = request.agent(app);
    const ordinaryId = await signup(ordinary, normalEmail);

    for (const endpoint of ["/organizations", "/users", "/health"]) {
      const adminResult = await master.get(`/api/platform-admin${endpoint}`);
      expect(adminResult.status).toBe(200);
      expect(JSON.stringify(adminResult.body)).not.toContain(password);
      expect(
        (
          await ordinary
            .get(`/api/platform-admin${endpoint}`)
            .set("x-email", masterEmail)
        ).status,
      ).toBe(403);
    }

    // Every platform surface rejects an authenticated non-admin before its
    // handler runs, even with forged email/admin fields.
    const deniedRequests = [
      () => ordinary.get(`/api/platform-admin/users/${ordinaryId}/status`),
      () => ordinary.post(`/api/platform-admin/users/${ordinaryId}/deactivate`),
      () => ordinary.post(`/api/platform-admin/users/${ordinaryId}/reactivate`),
      () =>
        ordinary.post(`/api/platform-admin/users/${ordinaryId}/password-reset`),
      () =>
        ordinary.post("/api/platform-admin/users").send({
          email: masterEmail,
          password,
          isMasterAdmin: true,
        }),
    ];
    for (const makeRequest of deniedRequests) {
      expect((await makeRequest().set("x-email", masterEmail)).status).toBe(403);
    }

    const createdEmail = `created.${nonce}@example.test`;
    const created = await master.post("/api/platform-admin/users").send({
      email: createdEmail,
      name: "Created User",
      password,
    });
    expect(created.status).toBe(201);
    expect(Object.keys(created.body).sort()).toEqual(
      ["createdAt", "email", "id", "name", "status"].sort(),
    );
    expect(JSON.stringify(created.body)).not.toContain(password);
    const duplicate = await master.post("/api/platform-admin/users").send({
      email: createdEmail.toUpperCase(),
      password,
    });
    expect(duplicate.status).toBe(409);

    const status = await master.get(
      `/api/platform-admin/users/${created.body.id}/status`,
    );
    expect(status.status).toBe(200);
    expect(Object.keys(status.body).sort()).toEqual(
      ["id", "lockedUntil", "loginAvailable", "status"].sort(),
    );
    expect(
      (
        await master.post(
          `/api/platform-admin/users/${created.body.id}/password-reset`,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await master.post(
          `/api/platform-admin/users/${created.body.id}/deactivate`,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await master.post(
          `/api/platform-admin/users/${created.body.id}/reactivate`,
        )
      ).status,
    ).toBe(200);

    const audit = await db
      .select()
      .from(platformAuditLogTable)
      .where(eq(platformAuditLogTable.actorUserId, ordinaryId));
    expect(audit.some((entry) => entry.outcome === "denied")).toBe(true);

    const old = process.env.MASTER_ADMIN_EMAIL;
    for (const invalid of [undefined, " ", "not-an-email"]) {
      if (invalid === undefined) delete process.env.MASTER_ADMIN_EMAIL;
      else process.env.MASTER_ADMIN_EMAIL = invalid;
      expect((await master.get("/api/platform-admin/health")).status).toBe(403);
    }
    process.env.MASTER_ADMIN_EMAIL = old;

    // A configured operator identity cannot be claimed through public signup;
    // the shell provisioning path is the only allowed creator.
    const reservedEmail = `reserved.${nonce}@example.test`;
    process.env.MASTER_ADMIN_EMAIL = reservedEmail;
    const reservedSignup = await request(app)
      .post("/api/auth/signup")
      .send({ email: reservedEmail, password });
    expect(reservedSignup.status).toBe(409);
    process.env.MASTER_ADMIN_EMAIL = old;

    // A legacy session with only userId cannot acquire platform privileges.
    const sid = `legacy-${nonce}`;
    const expires = new Date(Date.now() + 60_000);
    const [masterUser] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, masterEmail));
    await db.insert(sessionTable).values({
      sid,
      sess: {
        cookie: {
          originalMaxAge: 60_000,
          expires: expires.toISOString(),
          secure: false,
          httpOnly: true,
          path: "/",
          sameSite: "lax",
        },
        userId: masterUser.id,
      },
      expire: expires,
    });
    const signature = crypto
      .createHmac(
        "sha256",
        process.env.SESSION_SECRET ??
          "insecure-dev-secret-do-not-use-in-production",
      )
      .update(sid)
      .digest("base64")
      .replace(/=+$/, "");
    const legacyCookie = encodeURIComponent(`s:${sid}.${signature}`);
    expect(
      (
        await request(app)
          .get("/api/platform-admin/health")
          .set("Cookie", `sid=${legacyCookie}`)
      ).status,
    ).toBe(401);

    // A persisted identity change destroys the current session rather than
    // silently moving its privilege to a different email.
    await db
      .update(usersTable)
      .set({ email: `changed.${masterEmail}` })
      .where(eq(usersTable.id, masterUser.id));
    expect((await master.get("/api/platform-admin/health")).status).toBe(401);
    await db
      .update(usersTable)
      .set({ email: masterEmail })
      .where(eq(usersTable.id, masterUser.id));
    expect((await master.get("/api/platform-admin/health")).status).toBe(401);
  });

  it("does not bypass non-member financial permissions", async () => {
    const master = await loginMaster();
    const owner = request.agent(app);
    await signup(owner, `owner.${nonce}@example.test`);
    const createdOrg = await owner
      .post("/api/orgs")
      .send({ name: `Financial Boundary ${nonce}` });
    expect(createdOrg.status).toBe(201);
    const orgId = createdOrg.body.id as string;

    for (const path of [
      `/api/orgs/${orgId}/reports/trial-balance`,
      `/api/orgs/${orgId}/invoices`,
      `/api/orgs/${orgId}/bank-transactions`,
    ]) {
      const response = await master.get(path);
      expect(response.status, path).toBe(403);
    }

    const [masterUser] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, masterEmail));
    const reservedInvite = await owner
      .post(`/api/orgs/${orgId}/members`)
      .send({ email: masterEmail, role: "view_only" });
    expect(reservedInvite.status).toBe(409);
    const forbiddenMembership = await db
      .select()
      .from(membershipsTable)
      .where(
        and(
          eq(membershipsTable.orgId, orgId),
          eq(membershipsTable.userId, masterUser.id),
        ),
      );
    expect(forbiddenMembership).toHaveLength(0);

    await db.insert(membershipsTable).values({
      orgId,
      userId: masterUser.id,
      role: "view_only",
    });
    const forbiddenPost = await master
      .post(`/api/orgs/${orgId}/invoices`)
      .send({
        customer: "Tenant Customer",
        invoiceDate: "2026-09-08",
        dueDate: "2026-09-30",
        amount: "10.00",
      });
    expect(forbiddenPost.status).toBe(403);
  });

  it("enforces hash-only prior invalidation, expiry, single use, and session revocation", async () => {
    const master = await loginMaster();
    const user = request.agent(app);
    const userId = await signup(user, `reset.${nonce}@example.test`);

    const oldPublicUrl = process.env.PUBLIC_APP_URL;
    delete process.env.PUBLIC_APP_URL;
    const first = await master.post(
      `/api/platform-admin/users/${userId}/password-reset`,
    );
    expect(first.body.resetLink).toMatch(
      /^\/reset-password\?token=[A-Za-z0-9_-]+$/,
    );
    if (oldPublicUrl === undefined) delete process.env.PUBLIC_APP_URL;
    else process.env.PUBLIC_APP_URL = oldPublicUrl;
    const firstToken = resetToken(first.body.resetLink);
    const second = await master.post(
      `/api/platform-admin/users/${userId}/password-reset`,
    );
    const secondToken = resetToken(second.body.resetLink);
    const [firstStored] = await db
      .select()
      .from(passwordResetTokensTable)
      .where(
        and(
          eq(passwordResetTokensTable.userId, userId),
          eq(passwordResetTokensTable.tokenHash, tokenHash(firstToken)),
        ),
      );
    expect(firstStored.invalidatedAt).toBeInstanceOf(Date);
    expect(
      (
        await request(app).post("/api/auth/password-reset").send({
          token: firstToken,
          newPassword,
        })
      ).status,
    ).toBe(400);

    await db
      .update(passwordResetTokensTable)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(passwordResetTokensTable.tokenHash, tokenHash(secondToken)));
    expect(
      (
        await request(app).post("/api/auth/password-reset").send({
          token: secondToken,
          newPassword,
        })
      ).status,
    ).toBe(400);

    const third = await master.post(
      `/api/platform-admin/users/${userId}/password-reset`,
    );
    expect(third.status).toBe(200);
    const token = resetToken(third.body.resetLink);
    const [stored] = await db
      .select()
      .from(passwordResetTokensTable)
      .where(eq(passwordResetTokensTable.tokenHash, tokenHash(token)));
    expect(stored.tokenHash).toBe(tokenHash(token));
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(JSON.stringify(stored)).not.toContain(password);
    expect(
      (
        await request(app).post("/api/auth/password-reset").send({
          token: `${token}x`,
          newPassword,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post("/api/auth/password-reset")
          .send({ token, newPassword })
      ).status,
    ).toBe(204);
    expect(
      (
        await request(app)
          .post("/api/auth/password-reset")
          .send({ token, newPassword })
      ).status,
    ).toBe(400);
    expect((await user.get("/api/auth/session")).status).toBe(401);
    expect(
      (
        await request(app)
          .post("/api/auth/login")
          .send({ email: `reset.${nonce}@example.test`, password })
      ).status,
    ).toBe(401);
    const freshUser = request.agent(app);
    expect(
      (
        await freshUser.post("/api/auth/login").send({
          email: `reset.${nonce}@example.test`,
          password: newPassword,
        })
      ).status,
    ).toBe(200);
    const [resetUser] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, userId));
    expect(resetUser.passwordHash).toMatch(/^\$argon2id\$/);

    expect(
      (
        await master.post(
          `/api/platform-admin/users/${userId}/deactivate`,
        )
      ).status,
    ).toBe(200);
    const tokenCountBeforeDeactivatedTrigger = (
      await db
        .select()
        .from(passwordResetTokensTable)
        .where(eq(passwordResetTokensTable.userId, userId))
    ).length;
    expect(
      (
        await master.post(
          `/api/platform-admin/users/${userId}/password-reset`,
        )
      ).status,
    ).toBe(404);
    const tokenCountAfterDeactivatedTrigger = (
      await db
        .select()
        .from(passwordResetTokensTable)
        .where(eq(passwordResetTokensTable.userId, userId))
    ).length;
    expect(tokenCountAfterDeactivatedTrigger).toBe(
      tokenCountBeforeDeactivatedTrigger,
    );
    expect((await freshUser.get("/api/auth/session")).status).toBe(401);
    expect(
      (
        await request(app).post("/api/auth/login").send({
          email: `reset.${nonce}@example.test`,
          password: newPassword,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await master.post(
          `/api/platform-admin/users/${userId}/reactivate`,
        )
      ).status,
    ).toBe(200);
    expect((await freshUser.get("/api/auth/session")).status).toBe(401);
    expect(
      (
        await request(app).post("/api/auth/login").send({
          email: `reset.${nonce}@example.test`,
          password: newPassword,
        })
      ).status,
    ).toBe(200);

    const auditRows = await db
      .select()
      .from(platformAuditLogTable)
      .where(eq(platformAuditLogTable.entityId, userId));
    const serializedAudit = JSON.stringify(auditRows);
    expect(serializedAudit).not.toContain(password);
    expect(serializedAudit).not.toContain(newPassword);
    expect(serializedAudit).not.toContain(token);
  });

  it("serializes concurrent reset issuance and blocks pre-deactivation tokens", async () => {
    const master = await loginMaster();
    const target = await provisionUser({
      email: `race.${nonce}@example.test`,
      password,
    });

    const [first, second] = await Promise.all([
      master.post(`/api/platform-admin/users/${target.id}/password-reset`),
      master.post(`/api/platform-admin/users/${target.id}/password-reset`),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const active = await db
      .select()
      .from(passwordResetTokensTable)
      .where(
        and(
          eq(passwordResetTokensTable.userId, target.id),
          isNull(passwordResetTokensTable.invalidatedAt),
          isNull(passwordResetTokensTable.consumedAt),
        ),
      );
    expect(active).toHaveLength(1);

    const completionStatuses = await Promise.all(
      [resetToken(first.body.resetLink), resetToken(second.body.resetLink)].map(
        async (candidateToken) =>
          (
            await request(app).post("/api/auth/password-reset").send({
              token: candidateToken,
              newPassword,
            })
          ).status,
      ),
    );
    expect(completionStatuses.sort()).toEqual([204, 400]);

    const beforeDeactivate = await master.post(
      `/api/platform-admin/users/${target.id}/password-reset`,
    );
    expect(beforeDeactivate.status).toBe(200);
    const issuedToken = resetToken(beforeDeactivate.body.resetLink);
    expect(
      (
        await master.post(
          `/api/platform-admin/users/${target.id}/deactivate`,
        )
      ).status,
    ).toBe(200);
    const [invalidatedBeforeReactivation] = await db
      .select()
      .from(passwordResetTokensTable)
      .where(
        eq(passwordResetTokensTable.tokenHash, tokenHash(issuedToken)),
      );
    expect(invalidatedBeforeReactivation.invalidatedAt).toBeInstanceOf(Date);
    expect(
      (
        await master.post(
          `/api/platform-admin/users/${target.id}/reactivate`,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app).post("/api/auth/password-reset").send({
          token: issuedToken,
          newPassword,
        })
      ).status,
    ).toBe(400);
  });

  it("never logs malformed reset bodies containing token or password material", async () => {
    let logs = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        logs += chunk.toString();
        callback();
      },
    });
    const logApp = createApp({
      authRateLimitMax: 100,
      httpLogger: pino({ level: "info" }, destination),
    });
    const leakyToken = `raw-token-${nonce}`;
    const leakyPassword = `raw-password-${nonce}`;
    const response = await request(logApp)
      .post("/api/auth/password-reset")
      .set("Content-Type", "application/json")
      .send(`{"token":"${leakyToken}","newPassword":"${leakyPassword}"`);
    expect(response.status).toBe(400);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(logs).not.toContain(leakyToken);
    expect(logs).not.toContain(leakyPassword);
    expect(logs).not.toContain("newPassword");
  });

  it("rate-limits reset trigger and completion independently", async () => {
    const limitedTriggerApp = createApp({
      authRateLimitMax: 100,
      platformResetRateLimitMax: 1,
    });
    const limitedMaster = request.agent(limitedTriggerApp);
    expect(
      (
        await limitedMaster
          .post("/api/auth/login")
          .send({ email: masterEmail, password })
      ).status,
    ).toBe(200);
    const target = await provisionUser({
      email: `limited.${nonce}@example.test`,
      password,
    });
    expect(
      (
        await limitedMaster.post(
          `/api/platform-admin/users/${target.id}/password-reset`,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await limitedMaster.post(
          `/api/platform-admin/users/${target.id}/password-reset`,
        )
      ).status,
    ).toBe(429);

    const limitedCompletionApp = createApp({ authRateLimitMax: 1 });
    expect(
      (
        await request(limitedCompletionApp)
          .post("/api/auth/password-reset")
          .send({ token: "invalid-one", newPassword })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(limitedCompletionApp)
          .post("/api/auth/password-reset")
          .send({ token: "invalid-two", newPassword })
      ).status,
    ).toBe(429);
  });
});