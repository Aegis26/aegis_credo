/**
 * Bank-statement import: balance-reconciliation math (matched + mismatched),
 * idempotent re-upload, defensive upload validation. LLM extraction itself is
 * NOT tested here — final accuracy must be validated by a human against real
 * statements from multiple banks (text and scanned).
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { pool } from "@workspace/db";
import { createApp } from "./app";
import {
  reconcileStatement,
  parseModelJson,
  RawStatementSchema,
} from "./lib/statement-extraction";

const app = createApp();
const nonce = `bs${Date.now().toString(36)}`;
const PASSWORD = "correct-horse-battery";

afterAll(async () => {
  await pool.end();
});

describe("reconcileStatement (pure BigInt math)", () => {
  it("balances when opening + sum(transactions) equals closing", () => {
    // 100.00 + (250.00 - 40.00 - 10.00) = 300.00
    const r = reconcileStatement(10000n, 30000n, [25000n, -4000n, -1000n]);
    expect(r.balanced).toBe(true);
    expect(r.discrepancyMinor).toBe(0n);
    expect(r.computedClosingMinor).toBe(30000n);
  });

  it("reports the exact discrepancy when it does not balance", () => {
    // Missing a 25.00 withdrawal: computed 300.00 but statement says 275.00
    const r = reconcileStatement(10000n, 27500n, [25000n, -4000n, -1000n]);
    expect(r.balanced).toBe(false);
    expect(r.discrepancyMinor).toBe(-2500n);
  });

  it("handles negative (overdraft) balances and empty statements", () => {
    const r = reconcileStatement(-5000n, -5000n, []);
    expect(r.balanced).toBe(true);
    const r2 = reconcileStatement(-5000n, 1000n, [6000n]);
    expect(r2.balanced).toBe(true);
  });
});

describe("model output validation", () => {
  it("parses fenced JSON and validates the schema", () => {
    const text =
      '```json\n{"period_start":null,"period_end":null,"opening_balance":"1.00","closing_balance":"2.00","transactions":[{"date":"2026-01-02","description":"COFFEE","amount":"1.00","direction":"in","low_confidence":false}]}\n```';
    const parsed = RawStatementSchema.parse(parseModelJson(text));
    expect(parsed.transactions).toHaveLength(1);
  });

  it("rejects malformed rows (bad date, missing direction)", () => {
    expect(() =>
      RawStatementSchema.parse({
        period_start: null,
        period_end: null,
        opening_balance: "0.00",
        closing_balance: "0.00",
        transactions: [
          { date: "01/02/2026", description: "X", amount: "1.00", direction: "in", low_confidence: false },
        ],
      }),
    ).toThrow();
  });
});

describe("statement endpoints", () => {
  async function makeOrgAgent() {
    const agent = request.agent(app);
    const signup = await agent
      .post("/api/auth/signup")
      .send({ email: `${nonce}@example.test`, password: PASSWORD, name: "Stmt Tester" });
    expect(signup.status).toBe(201);
    const org = await agent.post("/api/orgs").send({ name: `Stmt Org ${nonce}` });
    expect(org.status).toBe(201);
    return { agent, orgId: org.body.id as string };
  }

  it("rejects a non-PDF upload before any parsing (400)", async () => {
    const { agent, orgId } = await makeOrgAgent();

    const res = await agent
      .post(`/api/orgs/${orgId}/bank/statement/extract`)
      .send({ content: Buffer.from("hello, not a pdf").toString("base64") });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/couldn't read/i);

    // Confirm endpoint validates rows strictly.
    const zero = await agent
      .post(`/api/orgs/${orgId}/bank/statement/confirm`)
      .send({ transactions: [{ date: "2026-01-05", description: "X", amount: "0.00" }] });
    expect(zero.status).toBe(400);

    const badDate = await agent
      .post(`/api/orgs/${orgId}/bank/statement/confirm`)
      .send({ transactions: [{ date: "01/05/2026", description: "X", amount: "1.00" }] });
    expect(badDate.status).toBe(400);

    const float = await agent
      .post(`/api/orgs/${orgId}/bank/statement/confirm`)
      .send({ transactions: [{ date: "2026-01-05", description: "X", amount: "1.005" }] });
    expect(float.status).toBe(400);

    // Idempotent re-upload: same reviewed rows confirmed twice — second call
    // inserts nothing (content dedup key, same mechanism as Plaid sync).
    const rows = {
      transactions: [
        { date: "2026-01-05", description: "ACME PAYROLL", amount: "2500.00" },
        { date: "2026-01-07", description: "OFFICE RENT", amount: "-1200.00" },
        { date: "2026-01-08", description: "Coffee  Shop", amount: "-4.50" },
      ],
    };
    const first = await agent
      .post(`/api/orgs/${orgId}/bank/statement/confirm`)
      .send(rows);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ inserted: 3, skippedDuplicates: 0 });

    const second = await agent
      .post(`/api/orgs/${orgId}/bank/statement/confirm`)
      .send(rows);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ inserted: 0, skippedDuplicates: 3 });

    // Whitespace/case-normalized description still dedupes (same key as Plaid).
    const renamed = await agent
      .post(`/api/orgs/${orgId}/bank/statement/confirm`)
      .send({ transactions: [{ date: "2026-01-08", description: "coffee shop", amount: "-4.50" }] });
    expect(renamed.body).toEqual({ inserted: 0, skippedDuplicates: 1 });

    // The rows are visible to the existing reconcile pipeline as unmatched.
    const list = await agent.get(`/api/orgs/${orgId}/bank-transactions`);
    expect(list.status).toBe(200);
    const descriptions = list.body.transactions.map((t: { description: string }) => t.description);
    expect(descriptions).toContain("ACME PAYROLL");
    expect(list.body.transactions.every((t: { matched: boolean }) => !t.matched)).toBe(true);
  });
});
