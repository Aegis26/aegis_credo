import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { db, pool, journalEntriesTable } from "@workspace/db";
import { createApp } from "./app";

const app = createApp();
const nonce = Date.now().toString(36);
const PASSWORD = "correct-horse-battery";

function email(tag: string): string {
  return `${tag}.${nonce}@example.test`;
}

async function newUser(tag: string) {
  const agent = request.agent(app);
  const res = await agent
    .post("/api/auth/signup")
    .send({ email: email(tag), password: PASSWORD, name: tag });
  expect(res.status).toBe(201);
  return { agent, userId: res.body.user.id as string };
}

async function newOrg(agent: request.Agent, name: string) {
  const res = await agent.post("/api/orgs").send({ name });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

function openingBody(cash: string, equityName: string) {
  return {
    source: "quickbooks" as const,
    accounts: [
      { code: "1000", name: "Cash", type: "asset" as const },
      { code: "3000", name: equityName, type: "equity" as const },
    ],
    openingBalances: [
      { accountCode: "1000", debit: cash },
      { accountCode: "3000", credit: cash },
    ],
  };
}

async function countEntries(orgId: string) {
  const rows = await db
    .select({ id: journalEntriesTable.id })
    .from(journalEntriesTable)
    .where(eq(journalEntriesTable.orgId, orgId));
  return rows.length;
}

afterAll(async () => {
  await pool.end();
});

describe("multi-import guard over HTTP", () => {
  it("second DIFFERENT import returns 409 and posts nothing; replace returns 200 and ties out", async () => {
    const { agent } = await newUser("guard-owner");
    const orgId = await newOrg(agent, `Guard ${nonce}`);

    const first = await agent
      .post(`/api/orgs/${orgId}/import`)
      .send(openingBody("500000", "Owner's Equity"));
    expect(first.status).toBe(200);
    expect(first.body.matched).toBe(true);

    const afterFirst = await countEntries(orgId);

    // A different file (different content hash) must be BLOCKED with 409.
    const blocked = await agent
      .post(`/api/orgs/${orgId}/import`)
      .send(openingBody("800000", "Owner Capital"));
    expect(blocked.status).toBe(409);
    expect(await countEntries(orgId)).toBe(afterFirst);

    // Same file again is still idempotent — 200 and nothing new.
    const same = await agent
      .post(`/api/orgs/${orgId}/import`)
      .send(openingBody("500000", "Owner's Equity"));
    expect(same.status).toBe(200);
    expect(await countEntries(orgId)).toBe(afterFirst);

    // Explicit replace: 200, reconciles to the NEW file, old entries reversed.
    const replaced = await agent
      .post(`/api/orgs/${orgId}/import`)
      .send({ ...openingBody("800000", "Owner Capital"), onExistingOpening: "replace" });
    expect(replaced.status).toBe(200);
    expect(replaced.body.matched).toBe(true);
    expect(replaced.body.sourceTotalDebit).toBe("8000.00");

    // Append-only: original + reversal + new = more entries, none deleted.
    expect(await countEntries(orgId)).toBeGreaterThan(afterFirst);

    // Trial balance now reflects ONLY the new file (cash nets to 8000.00).
    const tb = await agent.get(`/api/orgs/${orgId}/reports/trial-balance`);
    expect(tb.status).toBe(200);
    const cash = tb.body.rows.find((r: { code: string }) => r.code === "1000");
    expect(BigInt(Math.round(parseFloat(cash.debit) * 100)) -
      BigInt(Math.round(parseFloat(cash.credit) * 100))).toBe(800000n);
  });

  it("preview reports hasExistingOpeningBalances", async () => {
    const { agent } = await newUser("guard-preview");
    const orgId = await newOrg(agent, `GuardPrev ${nonce}`);

    await agent
      .post(`/api/orgs/${orgId}/import`)
      .send(openingBody("300000", "Owner's Equity"));

    const preview = await agent
      .post(`/api/orgs/${orgId}/import/preview`)
      .send({
        report: "qbo_trial_balance",
        contentType: "csv",
        content: "Account,Debit,Credit\nCash,100.00,\nOwner's Equity,,100.00\n",
      });
    expect(preview.status).toBe(200);
    expect(preview.body.hasExistingOpeningBalances).toBe(true);
  });
});
