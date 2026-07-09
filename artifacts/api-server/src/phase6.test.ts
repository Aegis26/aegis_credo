import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { db, pool, journalEntriesTable } from "@workspace/db";
import { createApp } from "./app";

const app = createApp();
const nonce = Date.now().toString(36);
const PASSWORD = "correct-horse-battery";

function email(tag: string): string {
  return `${tag}.${nonce}@example.test`;
}

/** A normalized QBO/Xero export body (no client ref — server hashes content). */
function sampleImportBody() {
  return {
    source: "quickbooks" as const,
    accounts: [
      { code: "1000", name: "Cash", type: "asset" as const },
      { code: "1100", name: "Accounts Receivable", type: "asset" as const },
      { code: "2000", name: "Accounts Payable", type: "liability" as const },
      { code: "3000", name: "Owner's Equity", type: "equity" as const },
      { code: "4000", name: "Sales Revenue", type: "revenue" as const },
      { code: "5100", name: "Rent Expense", type: "expense" as const },
      { code: "5300", name: "Utilities Expense", type: "expense" as const },
    ],
    openingBalances: [
      { accountCode: "1000", debit: "500000" },
      { accountCode: "3000", credit: "500000" },
    ],
    transactions: [
      {
        id: "t1",
        date: "2026-01-05",
        memo: "Cash sale",
        lines: [
          { accountCode: "1000", debit: "120000" },
          { accountCode: "4000", credit: "120000" },
        ],
      },
      {
        id: "t2",
        date: "2026-01-10",
        memo: "Pay rent",
        lines: [
          { accountCode: "5100", debit: "80000" },
          { accountCode: "1000", credit: "80000" },
        ],
      },
    ],
    openInvoices: [
      {
        id: "i1",
        customer: "Big Client",
        invoiceNumber: "INV-9",
        invoiceDate: "2026-01-12",
        dueDate: "2026-02-12",
        amount: "200000",
        arAccountCode: "1100",
        revenueAccountCode: "4000",
      },
    ],
    openBills: [
      {
        id: "b1",
        vendor: "Power Co",
        billNumber: "U-1",
        billDate: "2026-01-15",
        dueDate: "2026-02-15",
        amount: "45000",
        apAccountCode: "2000",
        expenseAccountCode: "5300",
      },
    ],
  };
}

/** Sign up a fresh user and return an authenticated agent + their user id. */
async function newUser(tag: string) {
  const agent = request.agent(app);
  const res = await agent
    .post("/api/auth/signup")
    .send({ email: email(tag), password: PASSWORD, name: tag });
  expect(res.status).toBe(201);
  return { agent, userId: res.body.user.id as string };
}

/** Create an org (caller becomes owner) and return its id. */
async function newOrg(agent: request.Agent, name: string) {
  const res = await agent.post("/api/orgs").send({ name });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

afterAll(async () => {
  await pool.end();
});

describe("migration-in import (content-hash idempotent, reconciles)", () => {
  it("imports a file, reconciles to the source TB, and re-import posts zero new rows", async () => {
    const { agent } = await newUser("import-owner");
    const orgId = await newOrg(agent, `Import ${nonce}`);
    const body = sampleImportBody();

    const first = await agent.post(`/api/orgs/${orgId}/import`).send(body);
    expect(first.status).toBe(200);
    expect(first.body.matched).toBe(true);
    expect(first.body.sourceBalanced).toBe(true);
    expect(first.body.sourceTotalDebit).toBe(first.body.ledgerTotalDebit);
    expect(first.body.sourceTotalCredit).toBe(first.body.ledgerTotalCredit);
    expect(first.body.invoicesCreated).toBe(1);
    expect(first.body.billsCreated).toBe(1);

    const countEntries = async () => {
      const rows = await db
        .select({ id: journalEntriesTable.id })
        .from(journalEntriesTable)
        .where(eq(journalEntriesTable.orgId, orgId));
      return rows.length;
    };
    const afterFirst = await countEntries();
    expect(afterFirst).toBeGreaterThan(0);

    // Re-importing the identical file content posts NOTHING new (idempotent).
    const second = await agent.post(`/api/orgs/${orgId}/import`).send(body);
    expect(second.status).toBe(200);
    expect(second.body.ref).toBe(first.body.ref);
    expect(second.body.matched).toBe(true);
    const afterSecond = await countEntries();
    expect(afterSecond).toBe(afterFirst);

    // The imported invoice feeds A/R aging.
    const aging = await agent
      .get(`/api/orgs/${orgId}/reports/ar-aging`)
      .query({ asOf: "2026-03-01" });
    expect(aging.status).toBe(200);
    expect(aging.body.total).toBe("2000.00");
    expect(aging.body.buckets["1-30"]).toBe("2000.00");
  });
});

describe("bills / AP over the posting service", () => {
  it("creates a bill and pays it partially, tracking outstanding", async () => {
    const { agent } = await newUser("bill-owner");
    const orgId = await newOrg(agent, `Bills ${nonce}`);

    const accounts = await agent.get(`/api/orgs/${orgId}/accounts`);
    expect(accounts.status).toBe(200);
    const expense = accounts.body.accounts.find(
      (a: { type: string }) => a.type === "expense",
    );
    expect(expense).toBeTruthy();

    const created = await agent.post(`/api/orgs/${orgId}/bills`).send({
      vendor: "Acme Supplies",
      billNumber: "B-100",
      billDate: "2026-02-01",
      dueDate: "2026-03-01",
      amount: "300.00",
      expenseAccountId: expense.id,
    });
    expect(created.status).toBe(201);
    expect(created.body.amount).toBe("300.00");
    expect(created.body.outstanding).toBe("300.00");
    expect(created.body.status).toBe("open");
    const billId = created.body.id as string;

    const paid = await agent
      .post(`/api/orgs/${orgId}/bills/${billId}/pay`)
      .send({ paymentDate: "2026-02-15", amount: "100.00" });
    expect(paid.status).toBe(200);
    expect(paid.body.paid).toBe("100.00");
    expect(paid.body.outstanding).toBe("200.00");

    const list = await agent.get(`/api/orgs/${orgId}/bills`);
    expect(list.status).toBe(200);
    const row = list.body.bills.find((b: { id: string }) => b.id === billId);
    expect(row.outstanding).toBe("200.00");
  });
});

describe("RBAC gating at the HTTP layer", () => {
  it("view_only members cannot post money or manage members", async () => {
    const owner = await newUser("rbac-owner");
    const viewer = await newUser("rbac-viewer");
    const orgId = await newOrg(owner.agent, `RBAC ${nonce}`);

    // Owner invites the viewer as view_only.
    const invite = await owner.agent.post(`/api/orgs/${orgId}/members`).send({
      email: email("rbac-viewer"),
      role: "view_only",
    });
    expect(invite.status).toBe(201);
    expect(invite.body.role).toBe("view_only");
    expect(invite.body.active).toBe(true);

    const accounts = await owner.agent.get(`/api/orgs/${orgId}/accounts`);
    const expenseId = accounts.body.accounts.find(
      (a: { type: string }) => a.type === "expense",
    ).id;

    // view_only can read reports.
    const read = await viewer.agent.get(`/api/orgs/${orgId}/reports/ar-aging`);
    expect(read.status).toBe(200);

    // view_only cannot post a bill (ledger.post denied).
    const denied = await viewer.agent.post(`/api/orgs/${orgId}/bills`).send({
      vendor: "Nope",
      billDate: "2026-02-01",
      dueDate: "2026-03-01",
      amount: "50.00",
      expenseAccountId: expenseId,
    });
    expect(denied.status).toBe(403);

    // view_only cannot manage members (members.manage is owner-only).
    const cannotManage = await viewer.agent
      .post(`/api/orgs/${orgId}/members`)
      .send({ email: email("intruder"), role: "staff" });
    expect(cannotManage.status).toBe(403);
  });
});

describe("accountant collaboration is scoped to granted orgs", () => {
  it("an invited accountant sees only the org they were granted", async () => {
    const ownerA = await newUser("acct-ownerA");
    const ownerB = await newUser("acct-ownerB");
    const accountant = await newUser("acct-cpa");

    const orgA = await newOrg(ownerA.agent, `Acct A ${nonce}`);
    const orgB = await newOrg(ownerB.agent, `Acct B ${nonce}`);

    // Owner A invites the accountant to org A only.
    const invite = await ownerA.agent
      .post(`/api/orgs/${orgA}/accountants`)
      .send({ email: email("acct-cpa") });
    expect(invite.status).toBe(201);
    expect(invite.body.role).toBe("accountant");

    const orgs = await accountant.agent.get("/api/orgs");
    expect(orgs.status).toBe(200);
    const ids = orgs.body.orgs.map((o: { id: string }) => o.id);
    expect(ids).toContain(orgA);
    expect(ids).not.toContain(orgB);

    // The accountant can read org A's reports but not org B's.
    const readA = await accountant.agent.get(
      `/api/orgs/${orgA}/reports/trial-balance`,
    );
    expect(readA.status).toBe(200);
    const readB = await accountant.agent.get(
      `/api/orgs/${orgB}/reports/trial-balance`,
    );
    expect(readB.status).toBe(403);

    // Revoking the accountant hides org A again.
    const revoke = await ownerA.agent
      .post(`/api/orgs/${orgA}/members/${accountant.userId}/revoke`)
      .send({});
    expect(revoke.status).toBe(200);
    expect(revoke.body.active).toBe(false);

    const after = await accountant.agent.get("/api/orgs");
    const afterIds = after.body.orgs.map((o: { id: string }) => o.id);
    expect(afterIds).not.toContain(orgA);
  });
});
