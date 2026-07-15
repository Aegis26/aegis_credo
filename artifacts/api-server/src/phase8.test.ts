/**
 * Phase 8 — mid-market layer: consolidation, approvals, dimensions,
 * custom reports, budgets.
 *
 * Scenario: owner O runs a parent org P with two subsidiaries S1 and S2 in
 * one group. Intercompany activity (P charges S1 a management fee) must be
 * eliminated from consolidated statements. Approval rules must block bill
 * payment until sign-off. Dimension reports must reconcile to the trial
 * balance. An outsider with a valid session must be walled off everywhere.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { pool } from "@workspace/db";
import {
  postJournalEntry,
  parseDecimalToMinor,
  createDimension,
} from "@workspace/ledger";
import { createApp } from "./app";

const app = createApp();
const nonce = `p8${Date.now().toString(36)}`;
const PASSWORD = "correct-horse-battery";

const owner = request.agent(app);
const outsider = request.agent(app);

let groupId: string;
let parent: string;
let sub1: string;
let sub2: string;

/** code -> account id per org */
const acct: Record<string, Record<string, string>> = {};

async function loadAccounts(orgId: string) {
  const res = await owner.get(`/api/orgs/${orgId}/accounts`);
  expect(res.status).toBe(200);
  acct[orgId] = Object.fromEntries(
    res.body.accounts.map((a: { code: string; id: string }) => [a.code, a.id]),
  );
}

beforeAll(async () => {
  const oSignup = await owner
    .post("/api/auth/signup")
    .send({ email: `p8.owner.${nonce}@example.test`, password: PASSWORD });
  expect(oSignup.status).toBe(201);

  const xSignup = await outsider
    .post("/api/auth/signup")
    .send({ email: `p8.out.${nonce}@example.test`, password: PASSWORD });
  expect(xSignup.status).toBe(201);

  for (const [name, setter] of [
    [`P8 Parent ${nonce}`, (id: string) => (parent = id)],
    [`P8 Sub One ${nonce}`, (id: string) => (sub1 = id)],
    [`P8 Sub Two ${nonce}`, (id: string) => (sub2 = id)],
  ] as const) {
    const res = await owner.post("/api/orgs").send({ name });
    expect(res.status).toBe(201);
    setter(res.body.id);
  }
  await Promise.all([parent, sub1, sub2].map(loadAccounts));

  // --- Ledger activity (via the posting service; the API has no raw-entry
  // endpoint by design). Amounts in minor units.
  const d = (s: string) => parseDecimalToMinor(s);

  // External revenue: parent earns 10,000.00 cash sales.
  await postJournalEntry(parent, {
    entryDate: "2026-06-05",
    memo: "External sales",
    source: "p8-test",
    lines: [
      { accountId: acct[parent]["1000"], debit: d("10000") },
      { accountId: acct[parent]["4000"], credit: d("10000") },
    ],
  });

  // Sub1 external revenue 5,000.00; Sub2 external expense 2,000.00.
  await postJournalEntry(sub1, {
    entryDate: "2026-06-06",
    memo: "External sales",
    source: "p8-test",
    lines: [
      { accountId: acct[sub1]["1000"], debit: d("5000") },
      { accountId: acct[sub1]["4000"], credit: d("5000") },
    ],
  });
  await postJournalEntry(sub2, {
    entryDate: "2026-06-07",
    memo: "External rent",
    source: "p8-test",
    lines: [
      { accountId: acct[sub2]["6000"], debit: d("2000") },
      { accountId: acct[sub2]["1000"], credit: d("2000") },
    ],
  });

  // Group must exist BEFORE intercompany posts: the posting service rejects
  // counterpartyOrgId lines unless both orgs share a group.
  const g = await owner.post("/api/groups").send({ name: `P8 Group ${nonce}` });
  expect(g.status).toBe(201);
  groupId = g.body.id;
  for (const orgId of [parent, sub1, sub2]) {
    const res = await owner.post(`/api/groups/${groupId}/orgs`).send({ orgId });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  }

  // Intercompany: parent charges sub1 a 1,000.00 management fee. BOTH legs
  // are tagged with the counterparty org so elimination pairs them.
  await postJournalEntry(parent, {
    entryDate: "2026-06-10",
    memo: "Mgmt fee to S1",
    source: "p8-test",
    lines: [
      {
        accountId: acct[parent]["1000"],
        debit: d("1000"),
        counterpartyOrgId: sub1,
      },
      {
        accountId: acct[parent]["4000"],
        credit: d("1000"),
        counterpartyOrgId: sub1,
      },
    ],
  });
  await postJournalEntry(sub1, {
    entryDate: "2026-06-10",
    memo: "Mgmt fee from parent",
    source: "p8-test",
    lines: [
      {
        accountId: acct[sub1]["6000"],
        debit: d("1000"),
        counterpartyOrgId: parent,
      },
      {
        accountId: acct[sub1]["1000"],
        credit: d("1000"),
        counterpartyOrgId: parent,
      },
    ],
  });
});

afterAll(async () => {
  await pool.end();
});

describe("groups and consolidation", () => {
  it("lists the group with parent + two subsidiaries attached", async () => {
    const list = await owner.get("/api/groups");
    expect(list.status).toBe(200);
    const mine = list.body.groups.find((g: { id: string }) => g.id === groupId);
    expect(mine.orgs.map((o: { orgId: string }) => o.orgId).sort()).toEqual(
      [parent, sub1, sub2].sort(),
    );
  });

  it("a freshly created group with no member orgs appears in the creator's list immediately", async () => {
    const created = await owner
      .post("/api/groups")
      .send({ name: `Empty Group ${nonce}` });
    expect(created.status).toBe(201);

    const list = await owner.get("/api/groups");
    expect(list.status).toBe(200);
    const mine = list.body.groups.find(
      (g: { id: string }) => g.id === created.body.id,
    );
    expect(mine).toBeDefined();
    expect(mine.name).toBe(`Empty Group ${nonce}`);
    expect(mine.orgs).toEqual([]);

    // ...but NOT in an unrelated user's list.
    const other = await outsider.get("/api/groups");
    expect(other.status).toBe(200);
    expect(
      other.body.groups.find((g: { id: string }) => g.id === created.body.id),
    ).toBeUndefined();
  });

  it("an outsider cannot attach someone else's org to a group", async () => {
    const res = await outsider
      .post(`/api/groups/${groupId}/orgs`)
      .send({ orgId: parent });
    expect(res.status).toBe(403);
  });

  it("consolidated P&L eliminates the intercompany management fee", async () => {
    const res = await owner.get(
      `/api/groups/${groupId}/consolidated/profit-and-loss`,
    );
    expect(res.status).toBe(200);
    // Combined revenue would be 16,000 (10k + 5k external + 1k intercompany);
    // consolidated must show only outside-world activity: 15,000 revenue and
    // 2,000 expenses (S1's 1k fee expense eliminated with parent's 1k fee
    // revenue).
    expect(res.body.revenue).toBe("15000.00");
    expect(res.body.expenses).toBe("2000.00");
    expect(res.body.netIncome).toBe("13000.00");
  });

  it("consolidated trial balance balances and nets out intercompany", async () => {
    const res = await owner.get(
      `/api/groups/${groupId}/consolidated/trial-balance`,
    );
    expect(res.status).toBe(200);
    expect(res.body.totalDebit).toBe(res.body.totalCredit);
    expect(res.body.difference).toBe("0.00");
    expect(res.body.eliminations.length).toBeGreaterThan(0);
    const revenue = res.body.consolidated.find(
      (r: { code: string }) => r.code === "4000",
    );
    expect(revenue.balance).toBe("15000.00");
  });

  it("consolidated balance sheet closes with net income folded into equity", async () => {
    const res = await owner.get(
      `/api/groups/${groupId}/consolidated/balance-sheet`,
    );
    expect(res.status).toBe(200);
    expect(res.body.balances).toBe(true);
    expect(res.body.assets).toBe("13000.00");
    expect(res.body.netIncome).toBe("13000.00");
  });

  it("an outsider gets 403 on every consolidated read", async () => {
    for (const path of ["trial-balance", "profit-and-loss", "balance-sheet"]) {
      const res = await outsider.get(
        `/api/groups/${groupId}/consolidated/${path}`,
      );
      expect(res.status).toBe(403);
    }
  });

  it("rejects consolidated reads with no session", async () => {
    const res = await request(app).get(
      `/api/groups/${groupId}/consolidated/trial-balance`,
    );
    expect(res.status).toBe(401);
  });
});

describe("approval rules gate bill payment", () => {
  let bigBillId: string;
  let approvalId: string;

  it("owner creates a rule: bills at/above 500.00 need sign-off", async () => {
    const res = await owner
      .post(`/api/orgs/${parent}/approval-rules`)
      .send({ entityType: "bill", threshold: "500.00" });
    expect(res.status).toBe(201);
    expect(res.body.threshold).toBe("500.00");
    expect(res.body.active).toBe(true);

    const list = await owner.get(`/api/orgs/${parent}/approval-rules`);
    expect(list.status).toBe(200);
    expect(list.body.rules.length).toBe(1);
  });

  it("an outsider cannot create rules", async () => {
    const res = await outsider
      .post(`/api/orgs/${parent}/approval-rules`)
      .send({ entityType: "bill", threshold: "1.00" });
    expect(res.status).toBe(403);
  });

  it("a bill above the threshold opens a pending approval", async () => {
    const res = await owner.post(`/api/orgs/${parent}/bills`).send({
      vendor: "BigCo",
      billDate: "2026-06-15",
      dueDate: "2026-07-15",
      amount: "800.00",
      expenseAccountId: acct[parent]["6000"],
    });
    expect(res.status).toBe(201);
    bigBillId = res.body.id;

    const pending = await owner.get(
      `/api/orgs/${parent}/approvals?status=pending`,
    );
    expect(pending.status).toBe(200);
    const approval = pending.body.approvals.find(
      (a: { entityId: string }) => a.entityId === bigBillId,
    );
    expect(approval).toBeTruthy();
    expect(approval.amount).toBe("800.00");
    approvalId = approval.id;
  });

  it("paying the bill is blocked (409) while approval is pending", async () => {
    const res = await owner
      .post(`/api/orgs/${parent}/bills/${bigBillId}/pay`)
      .send({ paymentDate: "2026-06-16", amount: "800.00" });
    expect(res.status).toBe(409);
  });

  it("an outsider cannot decide the approval", async () => {
    const res = await outsider
      .post(`/api/orgs/${parent}/approvals/${approvalId}/decide`)
      .send({ decision: "approved" });
    expect(res.status).toBe(403);
  });

  it("after approval the payment goes through", async () => {
    const decide = await owner
      .post(`/api/orgs/${parent}/approvals/${approvalId}/decide`)
      .send({ decision: "approved", note: "ok" });
    expect(decide.status).toBe(200);
    expect(decide.body.status).toBe("approved");

    const pay = await owner
      .post(`/api/orgs/${parent}/bills/${bigBillId}/pay`)
      .send({ paymentDate: "2026-06-16", amount: "800.00" });
    expect(pay.status).toBe(200);
    expect(pay.body.status).toBe("paid");
  });

  it("a bill below the threshold needs no approval and pays immediately", async () => {
    const bill = await owner.post(`/api/orgs/${parent}/bills`).send({
      vendor: "SmallCo",
      billDate: "2026-06-17",
      dueDate: "2026-07-17",
      amount: "100.00",
      expenseAccountId: acct[parent]["6000"],
    });
    expect(bill.status).toBe(201);
    const pay = await owner
      .post(`/api/orgs/${parent}/bills/${bill.body.id}/pay`)
      .send({ paymentDate: "2026-06-18", amount: "100.00" });
    expect(pay.status).toBe(200);
  });

  it("the audit trail records rule creation and the decision", async () => {
    const res = await owner.get(`/api/orgs/${parent}/approvals/audit`);
    expect(res.status).toBe(200);
    const actions = res.body.events.map((e: { action: string }) => e.action);
    expect(actions).toContain("approval.rule.create");
    expect(actions.some((a: string) => a.includes("decide") || a.includes("approv"))).toBe(true);
  });
});

describe("dimensions and custom reports", () => {
  let classA: string;

  it("creates dimensions (ledger.post) and lists them (reports.read)", async () => {
    const res = await owner
      .post(`/api/orgs/${parent}/dimensions`)
      .send({ type: "class", name: "Consulting" });
    expect(res.status).toBe(201);
    classA = res.body.id;

    const list = await owner.get(`/api/orgs/${parent}/dimensions`);
    expect(list.status).toBe(200);
    expect(list.body.dimensions.map((d: { id: string }) => d.id)).toContain(
      classA,
    );

    const forbidden = await outsider.get(`/api/orgs/${parent}/dimensions`);
    expect(forbidden.status).toBe(403);
  });

  it("a dimension-grouped report reconciles to the trial balance", async () => {
    // Tag a revenue entry with the class.
    await postJournalEntry(parent, {
      entryDate: "2026-06-20",
      memo: "Consulting revenue",
      source: "p8-test",
      lines: [
        {
          accountId: acct[parent]["1000"],
          debit: parseDecimalToMinor("300"),
          classId: classA,
        },
        {
          accountId: acct[parent]["4000"],
          credit: parseDecimalToMinor("300"),
          classId: classA,
        },
      ],
    });

    const report = await owner
      .post(`/api/orgs/${parent}/report`)
      .send({ groupBy: ["class"] });
    expect(report.status).toBe(200);
    expect(report.body.totalDebit).toBe(report.body.totalCredit);

    const tb = await owner.get(`/api/orgs/${parent}/reports/trial-balance`);
    expect(tb.status).toBe(200);
    // Every line is counted exactly once (tagged or "(unassigned)"), so the
    // report's totals equal the org's trial balance totals.
    expect(report.body.totalDebit).toBe(tb.body.totalDebit);

    const tagged = report.body.rows.find(
      (r: { keys: Record<string, string> }) => r.keys.class === "Consulting",
    );
    expect(tagged.debit).toBe("300.00");
    expect(tagged.credit).toBe("300.00");
  });

  it("group-scoped reports require the org to belong to the group", async () => {
    const foreign = await owner.post("/api/orgs").send({
      name: `P8 Foreign ${nonce}`,
    });
    expect(foreign.status).toBe(201);
    const res = await owner
      .post(`/api/orgs/${foreign.body.id}/report`)
      .send({ groupBy: ["entity"], groupId });
    expect(res.status).toBe(403);
  });

  it("a group-scoped report grouped by entity covers all three entities", async () => {
    const res = await owner
      .post(`/api/orgs/${parent}/report`)
      .send({ groupBy: ["entity"], groupId });
    expect(res.status).toBe(200);
    expect(res.body.rows.length).toBe(3);
    expect(res.body.totalDebit).toBe(res.body.totalCredit);
  });

  it("an outsider cannot run reports", async () => {
    const res = await outsider
      .post(`/api/orgs/${parent}/report`)
      .send({ groupBy: ["account"] });
    expect(res.status).toBe(403);
  });
});

describe("budget vs actual", () => {
  let budgetId: string;

  it("creates a budget and sets a line", async () => {
    const res = await owner.post(`/api/orgs/${parent}/budgets`).send({
      name: "H1 2026",
      periodStart: "2026-01-01",
      periodEnd: "2026-06-30",
    });
    expect(res.status).toBe(201);
    budgetId = res.body.id;

    const line = await owner
      .post(`/api/orgs/${parent}/budgets/${budgetId}/lines`)
      .send({ accountId: acct[parent]["4000"], amount: "12000.00" });
    expect(line.status).toBe(200);
    expect(line.body.amount).toBe("12000.00");

    const list = await owner.get(`/api/orgs/${parent}/budgets`);
    expect(list.status).toBe(200);
    expect(list.body.budgets.map((b: { id: string }) => b.id)).toContain(
      budgetId,
    );
  });

  it("vs-actual derives actuals from the ledger and computes variance", async () => {
    const res = await owner.get(
      `/api/orgs/${parent}/budgets/${budgetId}/vs-actual`,
    );
    expect(res.status).toBe(200);
    const row = res.body.rows.find((r: { code: string }) => r.code === "4000");
    // Parent revenue within the window: 10,000 external + 1,000 intercompany
    // + 300 tagged = 11,300 (single-entity actuals do NOT eliminate).
    expect(row.budgeted).toBe("12000.00");
    expect(row.actual).toBe("11300.00");
    expect(row.variance).toBe("-700.00");
  });

  it("an outsider cannot read budgets", async () => {
    const res = await outsider.get(`/api/orgs/${parent}/budgets`);
    expect(res.status).toBe(403);
  });
});
