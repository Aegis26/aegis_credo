import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import ExcelJS from "exceljs";
import { and, eq } from "drizzle-orm";
import {
  db,
  pool,
  accountsTable,
  journalEntriesTable,
  journalLinesTable,
} from "@workspace/db";
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

describe("QBO Trial Balance CSV adapter (preview → post → reconcile)", () => {
  it("previews a real QBO TB CSV, surfaces ambiguous accounts, posts the draft, reconciles, and re-import posts zero", async () => {
    const { agent } = await newUser("qbo-owner");
    const orgId = await newOrg(agent, `QBO ${nonce}`);

    // A real-shaped QBO "Trial Balance" export: company/date preamble, a header
    // row, account rows (one amount thousands-separated + quoted to prove the
    // comma path), an unmapped account ("Ask My Accountant"), and a Total line.
    const csv = [
      "Craig's Design and Landscaping Services",
      "Trial Balance",
      "As of July 9, 2026",
      "",
      "Account,Debit,Credit",
      'Checking,"1,201.00",',
      "Accounts Receivable,2000.00,",
      "Ask My Accountant,300.00,",
      "Accounts Payable,,500.00",
      "Sales,,3001.00",
      "Total,3501.00,3501.00",
    ].join("\n");

    const preview = await agent
      .post(`/api/orgs/${orgId}/import/preview`)
      .send({ report: "qbo_trial_balance", contentType: "csv", content: csv });
    expect(preview.status).toBe(200);
    expect(preview.body.source).toBe("quickbooks");
    expect(preview.body.companyName).toBe(
      "Craig's Design and Landscaping Services",
    );
    expect(preview.body.balanced).toBe(true);
    // "1,201.00" → 120100 minor units (no float), summed to the file total.
    expect(preview.body.totalDebit).toBe("350100");
    expect(preview.body.totalCredit).toBe("350100");

    // "Ask My Accountant" is not in the name map → surfaced for Review, never
    // silently guessed. Mapped accounts (Checking, Sales…) are not.
    expect(preview.body.ambiguousCount).toBe(1);
    const ambiguous = preview.body.accounts.find(
      (a: { name: string }) => a.name === "Ask My Accountant",
    );
    expect(ambiguous.typeSource).toBe("ambiguous");
    expect(ambiguous.candidateTypes).toContain("expense");
    const checking = preview.body.accounts.find(
      (a: { name: string }) => a.name === "Checking",
    );
    expect(checking.typeSource).toBe("mapped");
    expect(checking.type).toBe("asset");
    expect(checking.debit).toBe("120100");

    // The returned draft is the canonical import body — post it to the frozen
    // POST /import and it must reconcile to the source TB exactly.
    const draft = preview.body.draft;
    expect(draft.source).toBe("quickbooks");

    const first = await agent.post(`/api/orgs/${orgId}/import`).send(draft);
    expect(first.status).toBe(200);
    expect(first.body.matched).toBe(true);
    expect(first.body.sourceBalanced).toBe(true);
    expect(first.body.sourceTotalDebit).toBe(first.body.ledgerTotalDebit);
    expect(first.body.sourceTotalCredit).toBe(first.body.ledgerTotalCredit);

    const countEntries = async () => {
      const rows = await db
        .select({ id: journalEntriesTable.id })
        .from(journalEntriesTable)
        .where(eq(journalEntriesTable.orgId, orgId));
      return rows.length;
    };
    const afterFirst = await countEntries();
    expect(afterFirst).toBeGreaterThan(0);

    // Re-posting the identical draft is idempotent (server hashes content).
    const second = await agent.post(`/api/orgs/${orgId}/import`).send(draft);
    expect(second.status).toBe(200);
    expect(second.body.ref).toBe(first.body.ref);
    expect(second.body.matched).toBe(true);
    const afterSecond = await countEntries();
    expect(afterSecond).toBe(afterFirst);
  });

  it("imports the full real Craig's TB: zero-balance account lands in the COA with NO journal lines, and clear expenses are typed expense", async () => {
    const { agent } = await newUser("qbo-craig-full");
    const orgId = await newOrg(agent, `QBO Craig ${nonce}`);

    // The real QBO sample-company export shape: colon-hierarchy sub-accounts,
    // a zero-balance account row (name only), and a TOTAL row.
    const csv = [
      "Craig's Design and Landscaping Services",
      "Trial Balance",
      '"As of Jul 9, 2026"',
      "",
      "Account Name,Debit,Credit",
      'Checking,"1,201.00",',
      "Savings,800.00,",
      'Accounts Receivable (A/R),"5,281.52",',
      "Inventory Asset,596.25,",
      'Undeposited Funds,"2,062.52",',
      'Truck:Original Cost,"13,495.00",',
      "Advertising,74.86,",
      "Automobile:Fuel,349.41,",
      "Equipment Rental,112.00,",
      "Insurance,241.23,",
      "Job Expenses,155.07,",
      "Job Expenses:Job Materials:Decks and Patios,234.04,",
      "Legal & Professional Fees,75.00,",
      "Maintenance and Repair:Equipment Repairs,185.00,",
      "Meals and Entertainment,28.49,",
      "Miscellaneous,100.00,",
      "Office Expenses,18.08,",
      "Rent or Lease,240.00,",
      "Utilities:Gas and Electric,114.09,",
      "Discounts given,89.50,",
      "Ask My Accountant,100.00,",
      'Accounts Payable (A/P),,"1,602.67"',
      "Mastercard,,157.72",
      "Visa,,900.00",
      "Arizona Dept. of Revenue Payable,,",
      "Board of Equalization Payable,,370.94",
      'Loan Payable,,"4,000.00"',
      'Opening Balance Equity,,"9,337.50"',
      "Retained Earnings,,604.94",
      'Design income,,"2,500.00"',
      'Landscaping Services,,"3,161.27"',
      'Landscaping Services:Job Materials:Fountains and Garden Lighting,,"1,501.72"',
      "Sales of Product Income,,912.75",
      "Services,,503.55",
      'TOTAL,"25,553.06","25,553.06"',
    ].join("\n");

    const preview = await agent
      .post(`/api/orgs/${orgId}/import/preview`)
      .send({ report: "qbo_trial_balance", contentType: "csv", content: csv });
    expect(preview.status).toBe(200);
    expect(preview.body.balanced).toBe(true);
    expect(preview.body.totalDebit).toBe("2555306");

    type PreviewAccount = {
      name: string;
      type: string;
      typeSource: string;
      debit: string;
      credit: string;
    };
    const accounts: PreviewAccount[] = preview.body.accounts;
    const byName = (n: string) => accounts.find((a) => a.name === n)!;

    // Zero-balance account is kept, typed liability ("payable" beats "revenue").
    const az = byName("Arizona Dept. of Revenue Payable");
    expect(az.debit).toBe("0");
    expect(az.credit).toBe("0");
    expect(az.type).toBe("liability");
    expect(az.typeSource).toBe("mapped");

    // TYPE assertions — a balanced import is NOT proof of correct typing.
    expect(byName("Equipment Rental").type).toBe("expense");
    expect(byName("Office Expenses").type).toBe("expense");
    expect(byName("Maintenance and Repair:Equipment Repairs").type).toBe(
      "expense",
    );
    expect(
      byName("Maintenance and Repair:Equipment Repairs").typeSource,
    ).toBe("inherited");
    expect(
      byName("Landscaping Services:Job Materials:Fountains and Garden Lighting")
        .type,
    ).toBe("revenue");
    expect(byName("Discounts given").type).toBe("revenue");
    expect(byName("Discounts given").typeSource).toBe("ambiguous");
    expect(byName("Miscellaneous").typeSource).toBe("ambiguous");
    expect(preview.body.ambiguousCount).toBe(3);

    // Post the draft — 33 opening lines; the zero-balance account must NOT
    // produce a "lines[i] must have exactly one of debit/credit" 400.
    expect(preview.body.draft.accounts).toHaveLength(34);
    expect(preview.body.draft.openingBalances).toHaveLength(33);
    const posted = await agent
      .post(`/api/orgs/${orgId}/import`)
      .send(preview.body.draft);
    expect(posted.status).toBe(200);
    expect(posted.body.matched).toBe(true);

    // The zero-balance account exists in the chart of accounts…
    const [azRow] = await db
      .select({ id: accountsTable.id })
      .from(accountsTable)
      .where(
        and(
          eq(accountsTable.orgId, orgId),
          eq(accountsTable.name, "Arizona Dept. of Revenue Payable"),
        ),
      );
    expect(azRow).toBeDefined();

    // …but produced ZERO journal lines.
    const azLines = await db
      .select({ id: journalLinesTable.id })
      .from(journalLinesTable)
      .where(
        and(
          eq(journalLinesTable.orgId, orgId),
          eq(journalLinesTable.accountId, azRow.id),
        ),
      );
    expect(azLines).toHaveLength(0);
  });

  it("parses an XLSX export with numeric amount cells to exact minor units (no float)", async () => {
    const { agent } = await newUser("qbo-xlsx");
    const orgId = await newOrg(agent, `QBO XLSX ${nonce}`);

    // Build a real .xlsx whose amounts are stored as native spreadsheet NUMBERS
    // (not text), to exercise the numeric-cell path end to end.
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Trial Balance");
    ws.addRow(["Craig's Design and Landscaping Services"]);
    ws.addRow(["Trial Balance"]);
    ws.addRow(["As of July 9, 2026"]);
    ws.addRow([]);
    ws.addRow(["Account", "Debit", "Credit"]);
    ws.addRow(["Checking", 1201, null]);
    ws.addRow(["Accounts Receivable", 2000.5, null]);
    ws.addRow(["Accounts Payable", null, 3201.5]);
    const buffer = await wb.xlsx.writeBuffer();
    const content = Buffer.from(buffer).toString("base64");

    const preview = await agent
      .post(`/api/orgs/${orgId}/import/preview`)
      .send({ report: "qbo_trial_balance", contentType: "xlsx", content });
    expect(preview.status).toBe(200);
    expect(preview.body.balanced).toBe(true);
    // 1201 → 120100, 2000.50 → 200050; total debit 320150 = total credit.
    expect(preview.body.totalDebit).toBe("320150");
    expect(preview.body.totalCredit).toBe("320150");
    const checking = preview.body.accounts.find(
      (a: { name: string }) => a.name === "Checking",
    );
    expect(checking.debit).toBe("120100");
    const ar = preview.body.accounts.find(
      (a: { name: string }) => a.name === "Accounts Receivable",
    );
    expect(ar.debit).toBe("200050");

    // The XLSX-derived draft posts and reconciles exactly, same as CSV.
    const posted = await agent
      .post(`/api/orgs/${orgId}/import`)
      .send(preview.body.draft);
    expect(posted.status).toBe(200);
    expect(posted.body.matched).toBe(true);
    expect(posted.body.sourceTotalDebit).toBe(posted.body.ledgerTotalDebit);
  });

  it("returns a friendly 400 when the file is not a recognisable TB export", async () => {
    const { agent } = await newUser("qbo-badfile");
    const orgId = await newOrg(agent, `QBO Bad ${nonce}`);
    const res = await agent
      .post(`/api/orgs/${orgId}/import/preview`)
      .send({
        report: "qbo_trial_balance",
        contentType: "csv",
        content: "just,some,random\ncsv,without,headers",
      });
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe("string");
    expect(res.body.error.length).toBeGreaterThan(0);
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
