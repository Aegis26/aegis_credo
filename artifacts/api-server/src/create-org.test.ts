import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { db, pool, organizationsTable, membershipsTable } from "@workspace/db";
import { createApp } from "./app";

const app = createApp();
const nonce = Date.now().toString(36);
const PASSWORD = "correct-horse-battery";

afterAll(async () => {
  await pool.end();
});

describe("user-facing org creation (POST /orgs)", () => {
  it("requires a session (401)", async () => {
    const res = await request(app).post("/api/orgs").send({ name: "Nope" });
    expect(res.status).toBe(401);
  });

  it("creates an org owned by the SESSION user, seeded, with a zero balanced trial balance", async () => {
    const agent = request.agent(app);
    const signup = await agent.post("/api/auth/signup").send({
      email: `orgcreate.${nonce}@example.test`,
      password: PASSWORD,
      name: "Org Creator",
    });
    expect(signup.status).toBe(201);
    const myUserId = signup.body.user.id;

    // Another user who must NOT end up owning anything here.
    const other = request.agent(app);
    const otherSignup = await other.post("/api/auth/signup").send({
      email: `orgvictim.${nonce}@example.test`,
      password: PASSWORD,
      name: "Other User",
    });
    const otherUserId = otherSignup.body.user.id;

    // A spoofed userId in the body is not in the schema and must be ignored:
    // the org is owned by the session user regardless.
    const created = await agent.post("/api/orgs").send({
      name: `Created From UI ${nonce}`,
      baseCurrency: "EUR",
      userId: otherUserId,
      ownerId: otherUserId,
    });
    expect(created.status).toBe(201);
    expect(created.body.role).toBe("owner");
    expect(created.body.baseCurrency).toBe("EUR");
    const orgId = created.body.id;

    // Ownership: exactly one membership, owned by the session user.
    const members = await db
      .select()
      .from(membershipsTable)
      .where(eq(membershipsTable.orgId, orgId));
    expect(members).toHaveLength(1);
    expect(members[0].userId).toBe(myUserId);
    expect(members[0].role).toBe("owner");

    // Persisted currency.
    const [org] = await db
      .select()
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId));
    expect(org.baseCurrency).toBe("EUR");

    // Appears in the creator's org list immediately (what the switcher shows).
    const list = await agent.get("/api/orgs");
    expect(list.status).toBe(200);
    expect(
      list.body.orgs.find((o: { id: string }) => o.id === orgId)?.role,
    ).toBe("owner");

    // ...and NOT in the other user's list.
    const otherList = await other.get("/api/orgs");
    expect(
      otherList.body.orgs.find((o: { id: string }) => o.id === orgId),
    ).toBeUndefined();
    // The other user cannot even read the new org.
    const otherAccounts = await other.get(`/api/orgs/${orgId}/accounts`);
    expect(otherAccounts.status).toBe(403);

    // Seeded with the starter chart of accounts.
    const accounts = await agent.get(`/api/orgs/${orgId}/accounts`);
    expect(accounts.status).toBe(200);
    expect(accounts.body.accounts.length).toBeGreaterThan(10);
    const codes = accounts.body.accounts.map((a: { code: string }) => a.code);
    expect(codes).toContain("1000");
    expect(codes).toContain("4000");

    // Trial balance starts at zero and balanced.
    const tb = await agent.get(`/api/orgs/${orgId}/reports/trial-balance`);
    expect(tb.status).toBe(200);
    expect(tb.body.totalDebit).toBe("0.00");
    expect(tb.body.totalCredit).toBe("0.00");
  });

  it("defaults base currency to USD and rejects a malformed currency", async () => {
    const agent = request.agent(app);
    await agent.post("/api/auth/signup").send({
      email: `orgdefaults.${nonce}@example.test`,
      password: PASSWORD,
      name: "Defaults",
    });

    const created = await agent
      .post("/api/orgs")
      .send({ name: `Defaults Org ${nonce}` });
    expect(created.status).toBe(201);
    expect(created.body.baseCurrency).toBe("USD");

    const bad = await agent
      .post("/api/orgs")
      .send({ name: "Bad Currency", baseCurrency: "us dollars" });
    expect(bad.status).toBe(400);
  });
});
