import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { db, pool, authEventsTable } from "@workspace/db";
import {
  seedOrganization,
  createPractice,
  addPracticeMember,
  grantClientAccess,
  createClosePeriod,
} from "@workspace/ledger";
import { createApp } from "./app";

const app = createApp();
const nonce = Date.now().toString(36);
const PASSWORD = "correct-horse-battery";

function email(tag: string): string {
  return `${tag}.${nonce}@example.test`;
}

afterAll(async () => {
  await pool.end();
});

describe("public routes", () => {
  it("serves health without a session", async () => {
    const res = await request(app).get("/api/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});

describe("session gate", () => {
  it("rejects a protected route with no session (401)", async () => {
    const res = await request(app).get("/api/practice/clients");
    expect(res.status).toBe(401);
    expect(res.body.error).toBeTruthy();
  });

  it("rejects a garbage session cookie (401)", async () => {
    const res = await request(app)
      .get("/api/practice/clients")
      .set("Cookie", "sid=s%3Anot-a-real-session.deadbeef");
    expect(res.status).toBe(401);
  });
});

describe("signup / session / logout", () => {
  it("signs up, reads session, then logs out", async () => {
    const agent = request.agent(app);
    const addr = email("lifecycle");

    const signup = await agent
      .post("/api/auth/signup")
      .send({ email: addr, password: PASSWORD, name: "Life Cycle" });
    expect(signup.status).toBe(201);
    expect(signup.body.user.email).toBe(addr);
    expect(signup.body.user.id).toBeTruthy();
    // Password material must never be echoed back.
    expect(JSON.stringify(signup.body)).not.toContain(PASSWORD);

    const sess = await agent.get("/api/auth/session");
    expect(sess.status).toBe(200);
    expect(sess.body.user.id).toBe(signup.body.user.id);

    const logout = await agent.post("/api/auth/logout");
    expect(logout.status).toBe(204);

    const after = await agent.get("/api/auth/session");
    expect(after.status).toBe(401);
  });

  it("rejects duplicate email signup (409)", async () => {
    const addr = email("dupe");
    const first = await request(app)
      .post("/api/auth/signup")
      .send({ email: addr, password: PASSWORD });
    expect(first.status).toBe(201);
    const second = await request(app)
      .post("/api/auth/signup")
      .send({ email: addr, password: PASSWORD });
    expect(second.status).toBe(409);
  });
});

describe("login", () => {
  it("logs in with correct credentials and rejects wrong ones", async () => {
    const addr = email("login");
    await request(app)
      .post("/api/auth/signup")
      .send({ email: addr, password: PASSWORD });

    const agent = request.agent(app);
    const good = await agent
      .post("/api/auth/login")
      .send({ email: addr, password: PASSWORD });
    expect(good.status).toBe(200);
    expect(good.body.user.email).toBe(addr);

    const authed = await agent.get("/api/auth/session");
    expect(authed.status).toBe(200);

    const badPw = await request(app)
      .post("/api/auth/login")
      .send({ email: addr, password: "wrong-password" });
    expect(badPw.status).toBe(401);

    const unknown = await request(app)
      .post("/api/auth/login")
      .send({ email: email("nobody"), password: PASSWORD });
    expect(unknown.status).toBe(401);
  });
});

describe("identity comes from the session, never the client (IDOR)", () => {
  it("scopes practice access to the session user and ignores supplied ids", async () => {
    // User A gets practice access to org X; user B gets none.
    const agentA = request.agent(app);
    const signupA = await agentA
      .post("/api/auth/signup")
      .send({ email: email("idorA"), password: PASSWORD, name: "A" });
    expect(signupA.status).toBe(201);
    const userAId: string = signupA.body.user.id;

    const agentB = request.agent(app);
    const signupB = await agentB
      .post("/api/auth/signup")
      .send({ email: email("idorB"), password: PASSWORD, name: "B" });
    expect(signupB.status).toBe(201);

    const orgX = await seedOrganization(`IDOR Client ${nonce}`);
    const orgId = orgX.organization.id;
    const practice = await createPractice(`IDOR Practice ${nonce}`);
    await addPracticeMember(practice.id, userAId);
    await grantClientAccess(practice.id, orgId);
    const period = await createClosePeriod(orgId, "2026-01");

    // A sees the granted client.
    const aClients = await agentA.get("/api/practice/clients");
    expect(aClients.status).toBe(200);
    expect(
      aClients.body.clients.some(
        (c: { orgId: string }) => c.orgId === orgId,
      ),
    ).toBe(true);

    // B, with no grant, sees none of A's clients.
    const bClients = await agentB.get("/api/practice/clients");
    expect(bClients.status).toBe(200);
    expect(
      bClients.body.clients.some(
        (c: { orgId: string }) => c.orgId === orgId,
      ),
    ).toBe(false);

    // A can read the client's close periods.
    const aRead = await agentA.get(
      `/api/clients/${orgId}/close-periods/${period.id}/status`,
    );
    expect(aRead.status).toBe(200);

    // B cannot — even when trying to impersonate A via a query param.
    const bRead = await agentB.get(
      `/api/clients/${orgId}/close-periods?userId=${userAId}`,
    );
    expect(bRead.status).toBe(403);

    // Unauthenticated is blocked before the handler.
    const anon = await request(app).get(
      `/api/clients/${orgId}/close-periods`,
    );
    expect(anon.status).toBe(401);
  });
});

describe("lockout", () => {
  it("locks the account after repeated failures without leaking account existence", async () => {
    const addr = email("lockme");
    await request(app)
      .post("/api/auth/signup")
      .send({ email: addr, password: PASSWORD });

    // 5 wrong attempts trip the lockout — every failure looks identical (401).
    for (let i = 0; i < 5; i++) {
      const r = await request(app)
        .post("/api/auth/login")
        .send({ email: addr, password: "nope" });
      expect(r.status).toBe(401);
    }

    // The correct password is now refused: lockout is enforced. Crucially the
    // status is a generic 401 — identical to a wrong password and to an unknown
    // email — so a locked account is indistinguishable from a nonexistent one.
    const lockedButCorrect = await request(app)
      .post("/api/auth/login")
      .send({ email: addr, password: PASSWORD });
    expect(lockedButCorrect.status).toBe(401);

    const unknown = await request(app)
      .post("/api/auth/login")
      .send({ email: email("ghost"), password: PASSWORD });
    expect(unknown.status).toBe(401);
    expect(lockedButCorrect.status).toBe(unknown.status);

    // Lockout really happened — proven via the internal audit trail, not the
    // client-visible response.
    const rows = await db
      .select()
      .from(authEventsTable)
      .where(eq(authEventsTable.email, addr));
    expect(rows.map((r) => r.event)).toContain("account_locked");
  });
});

describe("rate limiting", () => {
  it("returns 429 once the auth window is exhausted", async () => {
    const rlApp = createApp({ authRateLimitMax: 3 });
    const addr = email("ratelimit");
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await request(rlApp)
        .post("/api/auth/login")
        .send({ email: addr, password: "whatever" });
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 3).every((s) => s !== 429)).toBe(true);
    expect(statuses[3]).toBe(429);
  });
});

describe("auth events are audited", () => {
  it("records signup, login and failed-login events", async () => {
    const addr = email("audit");
    await request(app)
      .post("/api/auth/signup")
      .send({ email: addr, password: PASSWORD });
    await request(app)
      .post("/api/auth/login")
      .send({ email: addr, password: PASSWORD });
    await request(app)
      .post("/api/auth/login")
      .send({ email: addr, password: "wrong" });

    const rows = await db
      .select()
      .from(authEventsTable)
      .where(eq(authEventsTable.email, addr));
    const events = rows.map((r) => r.event);
    expect(events).toContain("signup");
    expect(events).toContain("login");
    expect(events).toContain("login_failed");
  });
});
