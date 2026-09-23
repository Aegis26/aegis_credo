import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { createApp } from "./app";

const app = createApp({ apiRateLimitMax: 1000, authRateLimitMax: 1000 });
const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "integration-test-password";

let owner: ReturnType<typeof request.agent>;
let outsider: ReturnType<typeof request.agent>;
let ownerId = "";
let outsiderId = "";
let orgId = "";
let otherOrgId = "";
let firstCredentialId = "";
let firstKey = "";
let readOnlyKey = "";
let readOnlyCredentialId = "";

async function signup(agent: ReturnType<typeof request.agent>, suffix: string) {
  const response = await agent.post("/api/auth/signup").send({
    email: `machine.${suffix}.${nonce}@example.test`,
    password,
    name: `Machine Test ${suffix}`,
  });
  expect(response.status).toBe(201);
  return response.body.user.id as string;
}

async function createOrg(agent: ReturnType<typeof request.agent>, name: string) {
  const response = await agent.post("/api/orgs").send({ name: `${name} ${nonce}` });
  expect(response.status).toBe(201);
  return response.body.id as string;
}

async function createCredential(scopes: string[]) {
  const response = await owner.post(`/api/orgs/${orgId}/credentials`).send({
    name: `integration ${scopes.join("-")}`,
    scopes,
  });
  expect(response.status).toBe(201);
  return {
    id: response.body.credential.id as string,
    key: response.body.apiKey as string,
  };
}

beforeAll(async () => {
  owner = request.agent(app);
  outsider = request.agent(app);
  ownerId = await signup(owner, "owner");
  outsiderId = await signup(outsider, "outsider");
  orgId = await createOrg(owner, "Machine Org");
  otherOrgId = await createOrg(owner, "Other Machine Org");

  const full = await createCredential([
    "read:invoices", "write:invoices", "read:gl", "write:gl",
    "read:reports", "read:customers",
  ]);
  firstCredentialId = full.id;
  firstKey = full.key;
  const readOnly = await createCredential(["read:invoices"]);
  readOnlyCredentialId = readOnly.id;
  readOnlyKey = readOnly.key;
});

afterAll(async () => {
  // Remove only rows created by this suite. The explicit order respects the
  // foreign keys used by the machine and ledger tables.
  await db.execute(sql`delete from journal_lines where org_id in (${orgId}, ${otherOrgId})`);
  await db.execute(sql`delete from journal_entries where org_id in (${orgId}, ${otherOrgId})`);
  await db.execute(sql`delete from machine_audit where org_id in (${orgId}, ${otherOrgId})`);
  await db.execute(sql`delete from machine_credentials where org_id in (${orgId}, ${otherOrgId})`);
  await db.execute(sql`delete from audit_log where org_id in (${orgId}, ${otherOrgId})`);
  await db.execute(sql`delete from accounts where org_id in (${orgId}, ${otherOrgId})`);
  await db.execute(sql`delete from memberships where org_id in (${orgId}, ${otherOrgId})`);
  await db.execute(sql`delete from organizations where id in (${orgId}, ${otherOrgId})`);
  await db.execute(sql`delete from auth_events where user_id in (${ownerId}, ${outsiderId})`);
  await db.execute(sql`delete from users where id in (${ownerId}, ${outsiderId})`);
});

describe("machine integration API against the development database", () => {
  it("permits a scoped read and rejects missing scope and wrong organization", async () => {
    const valid = await request(app)
      .get(`/api/integrations/orgs/${orgId}/invoices`)
      .set("Authorization", `Bearer ${firstKey}`);
    expect(valid.status).toBe(200);
    expect(valid.body).toEqual({ invoices: [] });

    const missingScope = await request(app)
      .get(`/api/integrations/orgs/${orgId}/gl-entries`)
      .set("Authorization", `Bearer ${readOnlyKey}`);
    expect(missingScope.status).toBe(403);

    const wrongOrg = await request(app)
      .get(`/api/integrations/orgs/${otherOrgId}/invoices`)
      .set("Authorization", `Bearer ${firstKey}`);
    expect(wrongOrg.status).toBe(403);
  });

  it("allows only an owner to manage credentials", async () => {
    const denied = await outsider
      .get(`/api/orgs/${orgId}/credentials`);
    expect(denied.status).toBe(403);
    const listed = await owner.get(`/api/orgs/${orgId}/credentials`);
    expect(listed.status).toBe(200);
    expect(listed.body.credentials.map((c: { id: string }) => c.id))
      .toEqual(expect.arrayContaining([firstCredentialId, readOnlyCredentialId]));
  });

  it("rotates keys, invalidating the old bearer immediately", async () => {
    const rotated = await owner
      .post(`/api/orgs/${orgId}/credentials/${firstCredentialId}/rotate`);
    expect(rotated.status).toBe(200);
    const newKey = rotated.body.apiKey as string;
    const oldResponse = await request(app)
      .get(`/api/integrations/orgs/${orgId}/invoices`)
      .set("Authorization", `Bearer ${firstKey}`);
    expect(oldResponse.status).toBe(401);
    const newResponse = await request(app)
      .get(`/api/integrations/orgs/${orgId}/invoices`)
      .set("Authorization", `Bearer ${newKey}`);
    expect(newResponse.status).toBe(200);
    firstKey = newKey;
  });

  it("revokes a credential and rejects it immediately", async () => {
    const revoked = await owner
      .delete(`/api/orgs/${orgId}/credentials/${readOnlyCredentialId}`);
    expect(revoked.status).toBe(200);
    const response = await request(app)
      .get(`/api/integrations/orgs/${orgId}/invoices`)
      .set("Authorization", `Bearer ${readOnlyKey}`);
    expect(response.status).toBe(401);
  });

  it("posts GL, returns it on GET, and enforces idempotency", async () => {
    const accounts = await owner.get(`/api/orgs/${orgId}/accounts`);
    expect(accounts.status).toBe(200);
    const debit = accounts.body.accounts.find((a: { code: string }) => a.code === "1000").id;
    const credit = accounts.body.accounts.find((a: { code: string }) => a.code === "4000").id;
    const body = {
      entryDate: "2026-01-15",
      memo: "Machine integration test",
      idempotencyKey: `gl-${nonce}`,
      lines: [
        { accountId: debit, debit: "12.50" },
        { accountId: credit, credit: "12.50" },
      ],
    };
    const posted = await request(app)
      .post(`/api/integrations/orgs/${orgId}/gl-entries`)
      .set("Authorization", `Bearer ${firstKey}`).send(body);
    expect(posted.status).toBe(201);
    const retry = await request(app)
      .post(`/api/integrations/orgs/${orgId}/gl-entries`)
      .set("Authorization", `Bearer ${firstKey}`).send(body);
    expect(retry.status).toBe(201);
    expect(retry.body.id).toBe(posted.body.id);

    const conflict = await request(app)
      .post(`/api/integrations/orgs/${orgId}/gl-entries`)
      .set("Authorization", `Bearer ${firstKey}`)
      .send({ ...body, memo: "different memo" });
    expect(conflict.status).toBe(409);

    const listed = await request(app)
      .get(`/api/integrations/orgs/${orgId}/gl-entries`)
      .set("Authorization", `Bearer ${firstKey}`);
    expect(listed.status).toBe(200);
    expect(listed.body.entries.some((entry: { id: string }) => entry.id === posted.body.id)).toBe(true);
  });
});