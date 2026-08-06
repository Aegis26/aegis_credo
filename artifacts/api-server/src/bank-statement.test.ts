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
  StatementExtractionError,
  detectInternalTransfers,
  checkRunningBalances,
} from "./lib/statement-extraction";
import { extractionErrorMessage } from "./routes/bank-statement";

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
  it("parses fenced JSON and validates the multi-account schema", () => {
    const text =
      '```json\n{"period_start":null,"period_end":null,"statement_total_ending_balance":"2.00","accounts":[{"account_name":"Checking","account_number_last4":"1234","opening_balance":"1.00","closing_balance":"2.00","transactions":[{"date":"2026-01-02","description":"COFFEE","amount":"1.00","direction":"in","running_balance":"2.00","low_confidence":false}]}]}\n```';
    const parsed = RawStatementSchema.parse(parseModelJson(text));
    expect(parsed.accounts).toHaveLength(1);
    expect(parsed.accounts[0].transactions).toHaveLength(1);
  });

  it("rejects malformed rows (bad date) and empty account lists", () => {
    expect(() =>
      RawStatementSchema.parse({
        period_start: null,
        period_end: null,
        statement_total_ending_balance: null,
        accounts: [
          {
            account_name: "Checking",
            account_number_last4: null,
            opening_balance: "0.00",
            closing_balance: "0.00",
            transactions: [
              { date: "01/02/2026", description: "X", amount: "1.00", direction: "in", running_balance: null, low_confidence: false },
            ],
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      RawStatementSchema.parse({
        period_start: null,
        period_end: null,
        statement_total_ending_balance: null,
        accounts: [],
      }),
    ).toThrow();
  });
});

describe("detectInternalTransfers", () => {
  const accts = (over: Partial<Parameters<typeof detectInternalTransfers>[0][0]>[] = []) => [
    {
      accountName: "Simply Checking",
      accountNumberLast4: "4821",
      transactions: [
        { date: "2026-07-10", description: "DEPOSIT FROM CHRIS S FORTUNE", signedMinor: 50000n },
        { date: "2026-07-14", description: "POS PURCHASE STORE", signedMinor: -8630n },
      ],
      ...over[0],
    },
    {
      accountName: "Chris s Fortune",
      accountNumberLast4: "9077",
      transactions: [
        { date: "2026-07-10", description: "WITHDRAWAL TO SIMPLY CHECKING", signedMinor: -50000n },
        { date: "2026-07-20", description: "INTEREST PAYMENT", signedMinor: 300n },
      ],
      ...over[1],
    },
  ];

  it("pairs an out-leg with a matching in-leg in another account", () => {
    const groups = detectInternalTransfers(accts());
    // in-leg acct0 txn0 ↔ out-leg acct1 txn0 share a group
    expect(groups.get("0:0")).toBeDefined();
    expect(groups.get("0:0")).toBe(groups.get("1:0"));
    // unrelated rows are not flagged
    expect(groups.get("0:1")).toBeUndefined();
    expect(groups.get("1:1")).toBeUndefined();
  });

  it("requires a description reference to the other account", () => {
    const groups = detectInternalTransfers([
      {
        accountName: "Alpha Savings",
        accountNumberLast4: null,
        transactions: [{ date: "2026-07-10", description: "RANDOM DEPOSIT", signedMinor: 50000n }],
      },
      {
        accountName: "Beta Checking",
        accountNumberLast4: null,
        transactions: [{ date: "2026-07-10", description: "RANDOM WITHDRAWAL", signedMinor: -50000n }],
      },
    ]);
    expect(groups.size).toBe(0);
  });

  it("requires matching magnitude and close dates", () => {
    const base = accts();
    base[1].transactions[0].date = "2026-07-15"; // 5 days apart
    expect(detectInternalTransfers(base).size).toBe(0);
    const base2 = accts();
    base2[1].transactions[0].signedMinor = -49900n;
    expect(detectInternalTransfers(base2).size).toBe(0);
  });

  it("never pairs two legs within the same account", () => {
    const groups = detectInternalTransfers([
      {
        accountName: "Solo Checking",
        accountNumberLast4: null,
        transactions: [
          { date: "2026-07-10", description: "TO SOLO CHECKING", signedMinor: -50000n },
          { date: "2026-07-10", description: "FROM SOLO CHECKING", signedMinor: 50000n },
        ],
      },
    ]);
    expect(groups.size).toBe(0);
  });
});

describe("checkRunningBalances", () => {
  it("passes a correct chain and flags a broken link, resyncing after", () => {
    // opening 100.00; +50 → 150; -20 → 130 (printed WRONG as 135); -5 → 130 from resynced 135
    const flags = checkRunningBalances(10000n, [
      { signedMinor: 5000n, runningMinor: 15000n },
      { signedMinor: -2000n, runningMinor: 13500n }, // misread — should be 130.00
      { signedMinor: -500n, runningMinor: 13000n }, // chains from resynced 135.00
    ]);
    expect(flags).toEqual([false, true, false]);
  });

  it("skips rows without a printed balance", () => {
    const flags = checkRunningBalances(10000n, [
      { signedMinor: 5000n, runningMinor: null },
      { signedMinor: -2000n, runningMinor: 13000n },
    ]);
    expect(flags).toEqual([false, false]);
  });
});

describe("extractionErrorMessage (specific, actionable causes)", () => {
  it("maps each failure kind to a distinct user message", () => {
    expect(
      extractionErrorMessage(new StatementExtractionError("too_long")),
    ).toMatch(/too long to read in one pass/i);
    expect(
      extractionErrorMessage(
        new StatementExtractionError("rate_limited", { status: 429 }),
      ),
    ).toMatch(/busy right now/i);
    expect(
      extractionErrorMessage(
        new StatementExtractionError("service", { status: 529 }),
      ),
    ).toMatch(/temporarily unavailable/i);
    expect(
      extractionErrorMessage(new StatementExtractionError("unreadable")),
    ).toMatch(/scanned copy|clearer scan/i);
    // Unknown errors still get a safe generic message.
    expect(extractionErrorMessage(new Error("boom"))).toMatch(
      /couldn't extract transactions/i,
    );
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
    expect(res.body.error).toMatch(/doesn't look like a PDF/i);

    // Over-10MB upload → specific size message (magic bytes present so the
    // size check is what fires).
    const big = Buffer.alloc(10 * 1024 * 1024 + 1);
    big.write("%PDF-1.4", 0, "latin1");
    const tooBig = await agent
      .post(`/api/orgs/${orgId}/bank/statement/extract`)
      .send({ content: big.toString("base64") });
    expect(tooBig.status).toBe(400);
    expect(tooBig.body.error).toMatch(/over 10 MB/i);

    // Password-protected PDF → specific password message.
    const PDFDocument = (await import("pdfkit")).default;
    const encrypted: Buffer = await new Promise((resolve, reject) => {
      const doc = new PDFDocument({ userPassword: "secret" });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
      doc.text("locked statement");
      doc.end();
    });
    const locked = await agent
      .post(`/api/orgs/${orgId}/bank/statement/extract`)
      .send({ content: encrypted.toString("base64") });
    expect(locked.status).toBe(400);
    expect(locked.body.error).toMatch(/password-protected/i);

    // Map to the seeded 1000 cash account for the validation cases below.
    const coa = await agent.get(`/api/orgs/${orgId}/accounts`);
    expect(coa.status).toBe(200);
    const cash1000 = coa.body.accounts.find((a: { code: string }) => a.code === "1000");
    const expense = coa.body.accounts.find((a: { type: string }) => a.type === "expense");
    expect(cash1000).toBeDefined();
    const wrap = (
      transactions: { date: string; description: string; amount: string; excluded?: boolean }[],
      openingBalance = "0.00",
      closingBalance = "0.00",
      accountName = "Simply Checking",
    ) => ({
      accounts: [
        {
          accountName,
          accountNumberLast4: "4821",
          openingBalance,
          closingBalance,
          cashAccountId: cash1000.id,
          transactions,
        },
      ],
    });

    // Confirm endpoint validates rows strictly.
    const zero = await agent
      .post(`/api/orgs/${orgId}/bank/statement/confirm`)
      .send(wrap([{ date: "2026-01-05", description: "X", amount: "0.00" }]));
    expect(zero.status).toBe(400);

    const badDate = await agent
      .post(`/api/orgs/${orgId}/bank/statement/confirm`)
      .send(wrap([{ date: "01/05/2026", description: "X", amount: "1.00" }], "0.00", "1.00"));
    expect(badDate.status).toBe(400);

    const float = await agent
      .post(`/api/orgs/${orgId}/bank/statement/confirm`)
      .send(wrap([{ date: "2026-01-05", description: "X", amount: "1.005" }]));
    expect(float.status).toBe(400);

    // Server-enforced extraction-fidelity check: rows (INCLUDING excluded
    // ones) must tie opening → closing, or the import is rejected.
    const unbalanced = await agent
      .post(`/api/orgs/${orgId}/bank/statement/confirm`)
      .send(wrap([{ date: "2026-01-05", description: "X", amount: "1.00" }], "0.00", "5.00"));
    expect(unbalanced.status).toBe(400);
    expect(unbalanced.body.error).toMatch(/doesn't balance/i);

    // Excluded rows count toward the balance but are not imported.
    const withExcluded = await agent
      .post(`/api/orgs/${orgId}/bank/statement/confirm`)
      .send(
        wrap(
          [
            { date: "2026-01-05", description: "KEEP ME", amount: "10.00" },
            { date: "2026-01-06", description: "TRANSFER LEG", amount: "-3.00", excluded: true },
          ],
          "0.00",
          "7.00",
        ),
      );
    expect(withExcluded.status).toBe(200);
    expect(withExcluded.body).toEqual({ inserted: 1, skippedDuplicates: 0 });

    // Mapping is mandatory; both-or-neither is rejected; non-asset rejected.
    const unmapped = await agent
      .post(`/api/orgs/${orgId}/bank/statement/confirm`)
      .send({
        accounts: [
          { accountName: "Simply Checking", openingBalance: "0.00", closingBalance: "1.00", transactions: [{ date: "2026-01-05", description: "X", amount: "1.00" }] },
        ],
      });
    expect(unmapped.status).toBe(400);
    expect(unmapped.body.error).toMatch(/map/i);

    const both = await agent
      .post(`/api/orgs/${orgId}/bank/statement/confirm`)
      .send({
        accounts: [
          {
            accountName: "Simply Checking",
            openingBalance: "0.00",
            closingBalance: "1.00",
            cashAccountId: cash1000.id,
            newAccount: { code: "1010", name: "Dup" },
            transactions: [{ date: "2026-01-05", description: "X", amount: "1.00" }],
          },
        ],
      });
    expect(both.status).toBe(400);

    if (expense) {
      const nonAsset = await agent
        .post(`/api/orgs/${orgId}/bank/statement/confirm`)
        .send({
          accounts: [
            {
              accountName: "Simply Checking",
              openingBalance: "0.00",
              closingBalance: "1.00",
              cashAccountId: expense.id,
              transactions: [{ date: "2026-01-05", description: "X", amount: "1.00" }],
            },
          ],
        });
      expect(nonAsset.status).toBe(400);
      expect(nonAsset.body.error).toMatch(/asset/i);
    }

    // Idempotent re-upload: same reviewed rows confirmed twice — second call
    // inserts nothing (content dedup key, same mechanism as Plaid sync).
    const rows = wrap(
      [
        { date: "2026-01-05", description: "ACME PAYROLL", amount: "2500.00" },
        { date: "2026-01-07", description: "OFFICE RENT", amount: "-1200.00" },
        { date: "2026-01-08", description: "Coffee  Shop", amount: "-4.50" },
      ],
      "0.00",
      "1295.50",
    );
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
      .send(wrap([{ date: "2026-01-08", description: "coffee shop", amount: "-4.50" }], "0.00", "-4.50"));
    expect(renamed.body).toEqual({ inserted: 0, skippedDuplicates: 1 });

    // The SAME transaction in a SIBLING account is a distinct row (account
    // identity is part of the dedup key), and a new asset account can be
    // created inline for it.
    const sibling = await agent
      .post(`/api/orgs/${orgId}/bank/statement/confirm`)
      .send({
        accounts: [
          {
            accountName: "Round Up Savings",
            accountNumberLast4: "9077",
            openingBalance: "0.00",
            closingBalance: "-4.50",
            newAccount: { code: "1015", name: "Round Up Savings" },
            transactions: [{ date: "2026-01-08", description: "Coffee  Shop", amount: "-4.50" }],
          },
        ],
      });
    expect(sibling.status).toBe(200);
    expect(sibling.body).toEqual({ inserted: 1, skippedDuplicates: 0 });
    const coaAfter = await agent.get(`/api/orgs/${orgId}/accounts`);
    const created = coaAfter.body.accounts.find((a: { code: string }) => a.code === "1015");
    expect(created).toBeDefined();
    expect(created.type).toBe("asset");

    // Staff can import (ledger.post) but CANNOT create chart-of-accounts
    // records inline — that needs coa.manage (owner only).
    const staffEmail = `staff-${nonce}@example.test`;
    const staffAgent = request.agent(app);
    const staffSignup = await staffAgent
      .post("/api/auth/signup")
      .send({ email: staffEmail, password: PASSWORD, name: "Staff Member" });
    expect(staffSignup.status).toBe(201);
    const invite = await agent
      .post(`/api/orgs/${orgId}/members`)
      .send({ email: staffEmail, role: "staff" });
    expect(invite.status).toBe(201);
    const staffNewAccount = await staffAgent
      .post(`/api/orgs/${orgId}/bank/statement/confirm`)
      .send({
        accounts: [
          {
            accountName: "Staff Fund",
            accountNumberLast4: null,
            openingBalance: "0.00",
            closingBalance: "5.00",
            newAccount: { code: "1020", name: "Staff Fund" },
            transactions: [{ date: "2026-01-09", description: "DEPOSIT", amount: "5.00" }],
          },
        ],
      });
    expect(staffNewAccount.status).toBe(403);
    // …but mapping to an EXISTING cash account still works for staff.
    const staffMapped = await staffAgent
      .post(`/api/orgs/${orgId}/bank/statement/confirm`)
      .send(
        wrap([{ date: "2026-01-09", description: "STAFF DEPOSIT", amount: "5.00" }], "0.00", "5.00"),
      );
    expect(staffMapped.status).toBe(200);

    // Categorizing a statement-imported row posts against ITS mapped cash
    // account (not the legacy 1000 fallback).
    if (expense) {
      const listAll = await agent.get(`/api/orgs/${orgId}/bank-transactions`);
      const siblingRow = listAll.body.transactions.find(
        (t: { description: string; matched: boolean }) =>
          t.description === "Coffee  Shop" && !t.matched,
      );
      expect(siblingRow).toBeDefined();
      const cat = await agent
        .post(`/api/orgs/${orgId}/bank-transactions/${siblingRow.id}/categorize`)
        .send({ accountId: expense.id });
      expect(cat.status).toBe(200);
      expect(cat.body.matched).toBe(true);
    }

    // The rows are visible to the existing reconcile pipeline as unmatched.
    const list = await agent.get(`/api/orgs/${orgId}/bank-transactions`);
    expect(list.status).toBe(200);
    const descriptions = list.body.transactions.map((t: { description: string }) => t.description);
    expect(descriptions).toContain("ACME PAYROLL");
    expect(list.body.transactions.every((t: { matched: boolean }) => !t.matched)).toBe(true);
  });
});
