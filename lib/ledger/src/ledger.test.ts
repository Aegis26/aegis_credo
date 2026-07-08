import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  db,
  pool,
  journalEntriesTable,
  journalLinesTable,
} from "@workspace/db";
import {
  seedOrganization,
  postJournalEntry,
  reverseJournalEntry,
  getAccountBalance,
  getTrialBalance,
  getProfitAndLoss,
  getBalanceSheet,
  UnbalancedEntryError,
  InvalidLineError,
  InvalidEntryError,
  NotFoundError,
  ForbiddenError,
  ImportError,
  upsertUser,
  addMember,
  inviteAccountant,
  revokeMember,
  listOrgsForUser,
  can,
  requirePermission,
  createBill,
  payBill,
  createInvoice,
  payInvoice,
  getArAging,
  postPayrollRun,
  importFile,
  type ImportFile,
} from "./index";
import type { SeededOrg } from "./seed";

let org: SeededOrg;

beforeAll(async () => {
  org = await seedOrganization("Acme Test Co");
});

afterAll(async () => {
  await pool.end();
});

function randCents(min: number, max: number): bigint {
  return BigInt(Math.floor(Math.random() * (max - min + 1)) + min);
}

describe("posting service", () => {
  it("posts a balanced entry and derives account balances", async () => {
    const { byCode } = org;
    const { entry, lines } = await postJournalEntry(org.organization.id, {
      entryDate: "2026-01-01",
      memo: "Owner funds the business",
      source: "manual",
      lines: [
        { accountId: byCode["1000"].id, debit: 500000n },
        { accountId: byCode["3000"].id, credit: 500000n },
      ],
    });

    expect(entry.id).toBeTruthy();
    expect(lines).toHaveLength(2);

    const cash = await getAccountBalance(org.organization.id, byCode["1000"].id);
    expect(cash.debit).toBe(500000n);
    expect(cash.balance).toBe(500000n);

    const equity = await getAccountBalance(
      org.organization.id,
      byCode["3000"].id,
    );
    expect(equity.credit).toBe(500000n);
    expect(equity.balance).toBe(500000n);
  });

  // DoD 1: Posting an unbalanced entry is rejected.
  it("rejects an unbalanced entry", async () => {
    const { byCode } = org;
    await expect(
      postJournalEntry(org.organization.id, {
        entryDate: "2026-01-02",
        source: "manual",
        lines: [
          { accountId: byCode["1000"].id, debit: 100000n },
          { accountId: byCode["3000"].id, credit: 99999n },
        ],
      }),
    ).rejects.toBeInstanceOf(UnbalancedEntryError);
  });

  it("rejects a line that is both debit and credit", async () => {
    const { byCode } = org;
    await expect(
      postJournalEntry(org.organization.id, {
        entryDate: "2026-01-02",
        source: "manual",
        lines: [
          { accountId: byCode["1000"].id, debit: 100n, credit: 100n },
          { accountId: byCode["3000"].id, credit: 100n },
        ],
      }),
    ).rejects.toBeInstanceOf(InvalidLineError);
  });

  it("rejects an entry with fewer than two lines", async () => {
    const { byCode } = org;
    await expect(
      postJournalEntry(org.organization.id, {
        entryDate: "2026-01-02",
        source: "manual",
        lines: [{ accountId: byCode["1000"].id, debit: 100n }],
      }),
    ).rejects.toBeInstanceOf(InvalidEntryError);
  });

  // DoD 6: No JS number in the monetary path — passing a number is rejected.
  it("rejects a JS number amount (integer minor units must be bigint)", async () => {
    const { byCode } = org;
    await expect(
      postJournalEntry(org.organization.id, {
        entryDate: "2026-01-02",
        source: "manual",
        lines: [
          // @ts-expect-error intentionally passing a number to prove it is rejected
          { accountId: byCode["1000"].id, debit: 100 },
          { accountId: byCode["3000"].id, credit: 100n },
        ],
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("rolls back atomically when a line references an invalid account", async () => {
    const { byCode } = org;
    const before = await db
      .select()
      .from(journalEntriesTable)
      .where(eq(journalEntriesTable.orgId, org.organization.id));

    await expect(
      postJournalEntry(org.organization.id, {
        entryDate: "2026-01-03",
        source: "manual",
        lines: [
          { accountId: byCode["1000"].id, debit: 100n },
          // non-existent account -> FK violation -> whole tx rolls back
          {
            accountId: "00000000-0000-0000-0000-000000000000",
            credit: 100n,
          },
        ],
      }),
    ).rejects.toBeTruthy();

    const after = await db
      .select()
      .from(journalEntriesTable)
      .where(eq(journalEntriesTable.orgId, org.organization.id));
    expect(after.length).toBe(before.length);
  });
});

describe("immutability & reversal (DoD 2)", () => {
  it("reversing creates a new entry and leaves the original untouched", async () => {
    const local = await seedOrganization("Reversal Co");
    const { byCode } = local;

    const { entry: original, lines: originalLines } = await postJournalEntry(
      local.organization.id,
      {
        entryDate: "2026-02-01",
        memo: "Sale on credit",
        source: "manual",
        lines: [
          { accountId: byCode["1100"].id, debit: 25000n },
          { accountId: byCode["4000"].id, credit: 25000n },
        ],
      },
    );

    const reversal = await reverseJournalEntry(
      local.organization.id,
      original.id,
      "entered in error",
    );

    // A new distinct entry was created, referencing the original.
    expect(reversal.entry.id).not.toBe(original.id);
    expect(reversal.entry.reversesEntryId).toBe(original.id);

    // The original entry and its lines are byte-for-byte unchanged.
    const [originalNow] = await db
      .select()
      .from(journalEntriesTable)
      .where(eq(journalEntriesTable.id, original.id));
    expect(originalNow).toEqual(original);

    const originalLinesNow = await db
      .select()
      .from(journalLinesTable)
      .where(eq(journalLinesTable.entryId, original.id))
      .orderBy(journalLinesTable.id);
    expect([...originalLinesNow].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      [...originalLines].sort((a, b) => a.id.localeCompare(b.id)),
    );

    // Net effect of original + reversal on each account is zero.
    const ar = await getAccountBalance(local.organization.id, byCode["1100"].id);
    const rev = await getAccountBalance(local.organization.id, byCode["4000"].id);
    expect(ar.balance).toBe(0n);
    expect(rev.balance).toBe(0n);

    await pool; // keep pool referenced
  });
});

describe("ledger invariants over random postings", () => {
  it("trial balance sums to zero after N random balanced entries (DoD 3)", async () => {
    const local = await seedOrganization("Random Trial Co");
    const { byCode } = local;
    const debitAccounts = [byCode["1000"], byCode["5100"], byCode["5200"]];
    const creditAccounts = [byCode["4000"], byCode["2000"], byCode["3000"]];

    for (let i = 0; i < 50; i++) {
      const amount = randCents(1, 1_000_000);
      const d = debitAccounts[i % debitAccounts.length];
      const c = creditAccounts[i % creditAccounts.length];
      await postJournalEntry(local.organization.id, {
        entryDate: "2026-03-01",
        source: "random",
        lines: [
          { accountId: d.id, debit: amount },
          { accountId: c.id, credit: amount },
        ],
      });
    }

    const trial = await getTrialBalance(local.organization.id);
    expect(trial.totalDebit).toBe(trial.totalCredit);
    expect(trial.difference).toBe(0n);
    // Every value is a bigint (no floats leaked in).
    for (const row of trial.rows) {
      expect(typeof row.debit).toBe("bigint");
      expect(typeof row.credit).toBe("bigint");
    }
  });

  it("Assets == Liabilities + Equity holds after arbitrary entries (DoD 4)", async () => {
    const local = await seedOrganization("Accounting Equation Co");
    const { byCode } = local;

    // A mix of realistic transactions touching every statement section.
    await postJournalEntry(local.organization.id, {
      entryDate: "2026-04-01",
      source: "manual",
      lines: [
        { accountId: byCode["1000"].id, debit: 1_000_000n },
        { accountId: byCode["3000"].id, credit: 1_000_000n },
      ],
    });
    await postJournalEntry(local.organization.id, {
      entryDate: "2026-04-02",
      source: "manual",
      lines: [
        { accountId: byCode["1200"].id, debit: 300_000n },
        { accountId: byCode["2000"].id, credit: 300_000n },
      ],
    });
    await postJournalEntry(local.organization.id, {
      entryDate: "2026-04-03",
      source: "manual",
      lines: [
        { accountId: byCode["1000"].id, debit: 450_000n },
        { accountId: byCode["4000"].id, credit: 450_000n },
      ],
    });
    await postJournalEntry(local.organization.id, {
      entryDate: "2026-04-04",
      source: "manual",
      lines: [
        { accountId: byCode["5100"].id, debit: 120_000n },
        { accountId: byCode["1000"].id, credit: 120_000n },
      ],
    });

    const bs = await getBalanceSheet(local.organization.id);
    expect(bs.balances).toBe(true);
    expect(bs.assets).toBe(bs.liabilities + bs.equityWithIncome);

    const pnl = await getProfitAndLoss(local.organization.id);
    expect(pnl.revenue).toBe(450_000n);
    expect(pnl.expenses).toBe(120_000n);
    expect(pnl.netIncome).toBe(330_000n);
  });
});

describe("multi-tenant isolation (DoD 5)", () => {
  it("a query scoped to Org A never returns Org B's rows", async () => {
    const orgA = await seedOrganization("Tenant A");
    const orgB = await seedOrganization("Tenant B");

    await postJournalEntry(orgA.organization.id, {
      entryDate: "2026-05-01",
      source: "manual",
      lines: [
        { accountId: orgA.byCode["1000"].id, debit: 111_000n },
        { accountId: orgA.byCode["3000"].id, credit: 111_000n },
      ],
    });
    await postJournalEntry(orgB.organization.id, {
      entryDate: "2026-05-01",
      source: "manual",
      lines: [
        { accountId: orgB.byCode["1000"].id, debit: 999_000n },
        { accountId: orgB.byCode["3000"].id, credit: 999_000n },
      ],
    });

    const trialA = await getTrialBalance(orgA.organization.id);
    const trialB = await getTrialBalance(orgB.organization.id);

    // A only sees its own accounts and amounts.
    const cashA = trialA.rows.find((r) => r.code === "1000");
    const cashB = trialB.rows.find((r) => r.code === "1000");
    expect(cashA?.debit).toBe(111_000n);
    expect(cashB?.debit).toBe(999_000n);

    // No account id from B appears in A's trial balance.
    const idsA = new Set(trialA.rows.map((r) => r.accountId));
    for (const r of trialB.rows) {
      expect(idsA.has(r.accountId)).toBe(false);
    }

    // Raw entry query scoped to A never includes B's entries.
    const entriesA = await db
      .select()
      .from(journalEntriesTable)
      .where(eq(journalEntriesTable.orgId, orgA.organization.id));
    for (const e of entriesA) {
      expect(e.orgId).toBe(orgA.organization.id);
    }

    // Reversing across tenants is impossible: B cannot reverse A's entry.
    const [aEntry] = await db
      .select()
      .from(journalEntriesTable)
      .where(
        and(
          eq(journalEntriesTable.orgId, orgA.organization.id),
          eq(journalEntriesTable.source, "manual"),
        ),
      )
      .limit(1);
    await expect(
      reverseJournalEntry(orgB.organization.id, aEntry.id, "cross-tenant"),
    ).rejects.toBeTruthy();
  });

  it("rejects posting an entry that references another org's account", async () => {
    const orgA = await seedOrganization("Isolation A");
    const orgB = await seedOrganization("Isolation B");

    // Org A tries to post using one of Org B's account ids.
    await expect(
      postJournalEntry(orgA.organization.id, {
        entryDate: "2026-06-01",
        source: "manual",
        lines: [
          { accountId: orgA.byCode["1000"].id, debit: 5000n },
          // Foreign-org account: must be rejected before/at write time.
          { accountId: orgB.byCode["3000"].id, credit: 5000n },
        ],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    // Nothing leaked into either org's ledger.
    const trialA = await getTrialBalance(orgA.organization.id);
    const trialB = await getTrialBalance(orgB.organization.id);
    expect(trialA.rows.every((r) => r.debit === 0n && r.credit === 0n)).toBe(
      true,
    );
    expect(trialB.rows.every((r) => r.debit === 0n && r.credit === 0n)).toBe(
      true,
    );
  });
});

describe("idempotency guard on the posting service", () => {
  it("posting twice with the same key returns the original and posts once", async () => {
    const local = await seedOrganization("Idempotent Co");
    const { byCode } = local;
    const key = "import:file-1:txn:42";

    const first = await postJournalEntry(
      local.organization.id,
      {
        entryDate: "2026-01-01",
        source: "import_txn",
        lines: [
          { accountId: byCode["1000"].id, debit: 70000n },
          { accountId: byCode["4000"].id, credit: 70000n },
        ],
      },
      { idempotencyKey: key },
    );

    const second = await postJournalEntry(
      local.organization.id,
      {
        entryDate: "2026-01-01",
        source: "import_txn",
        lines: [
          { accountId: byCode["1000"].id, debit: 70000n },
          { accountId: byCode["4000"].id, credit: 70000n },
        ],
      },
      { idempotencyKey: key },
    );

    expect(second.entry.id).toBe(first.entry.id);

    const entries = await db
      .select()
      .from(journalEntriesTable)
      .where(eq(journalEntriesTable.orgId, local.organization.id));
    expect(entries).toHaveLength(1);

    const cash = await getAccountBalance(
      local.organization.id,
      byCode["1000"].id,
    );
    expect(cash.balance).toBe(70000n);
  });
});

describe("RBAC (multi-user roles)", () => {
  it("gates permissions by role and denies unknown/foreign users", async () => {
    const local = await seedOrganization("RBAC Co");
    const orgId = local.organization.id;

    const owner = await upsertUser("owner@rbac.test", "Owner");
    const staff = await upsertUser("staff@rbac.test", "Staff");
    const viewer = await upsertUser("viewer@rbac.test", "Viewer");
    const stranger = await upsertUser("stranger@rbac.test", "Stranger");

    await addMember(orgId, owner.id, "owner", { actor: "system" });
    await addMember(orgId, staff.id, "staff", { actor: owner.id });
    await addMember(orgId, viewer.id, "view_only", { actor: owner.id });

    // Owner can do everything.
    expect(await can(orgId, owner.id, "ledger.post")).toBe(true);
    expect(await can(orgId, owner.id, "members.manage")).toBe(true);

    // Staff can post & reverse & read, but not manage members.
    expect(await can(orgId, staff.id, "ledger.post")).toBe(true);
    expect(await can(orgId, staff.id, "ledger.reverse")).toBe(true);
    expect(await can(orgId, staff.id, "members.manage")).toBe(false);

    // View-only can read but not post.
    expect(await can(orgId, viewer.id, "reports.read")).toBe(true);
    expect(await can(orgId, viewer.id, "ledger.post")).toBe(false);

    // A non-member has no access at all.
    expect(await can(orgId, stranger.id, "reports.read")).toBe(false);

    // requirePermission throws for the denied case, resolves for the allowed.
    await expect(
      requirePermission(orgId, viewer.id, "ledger.post"),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      requirePermission(orgId, staff.id, "ledger.post"),
    ).resolves.toBeUndefined();
  });

  it("revoking a member removes access and is audit-logged", async () => {
    const local = await seedOrganization("Revoke Co");
    const orgId = local.organization.id;
    const staff = await upsertUser("revoke-staff@rbac.test", "Temp Staff");
    await addMember(orgId, staff.id, "staff", { actor: "system" });

    expect(await can(orgId, staff.id, "ledger.post")).toBe(true);
    await revokeMember(orgId, staff.id, { actor: "system" });
    expect(await can(orgId, staff.id, "ledger.post")).toBe(false);

    const { auditLogTable } = await import("@workspace/db");
    const audits = await db
      .select()
      .from(auditLogTable)
      .where(
        and(
          eq(auditLogTable.orgId, orgId),
          eq(auditLogTable.action, "member.revoke"),
        ),
      );
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });
});

describe("external accountant collaboration", () => {
  it("an invited accountant sees only the orgs granted, revocably", async () => {
    const orgA = await seedOrganization("Accountant Client A");
    const orgB = await seedOrganization("Accountant Client B");
    const accountant = await upsertUser("cpa@firm.test", "External CPA");

    // Granted to A only.
    await inviteAccountant(orgA.organization.id, accountant.id, {
      actor: "system",
    });

    let orgs = await listOrgsForUser(accountant.id);
    expect(orgs).toContain(orgA.organization.id);
    expect(orgs).not.toContain(orgB.organization.id);

    // Read-only in the granted org; cannot post or manage.
    expect(
      await can(orgA.organization.id, accountant.id, "reports.read"),
    ).toBe(true);
    expect(
      await can(orgA.organization.id, accountant.id, "ledger.post"),
    ).toBe(false);
    // No access at all to org B.
    expect(
      await can(orgB.organization.id, accountant.id, "reports.read"),
    ).toBe(false);

    // Revoke access to A -> no orgs remain.
    await revokeMember(orgA.organization.id, accountant.id, { actor: "system" });
    orgs = await listOrgsForUser(accountant.id);
    expect(orgs).not.toContain(orgA.organization.id);
    expect(
      await can(orgA.organization.id, accountant.id, "reports.read"),
    ).toBe(false);
  });
});

describe("accounts payable", () => {
  it("records a bill and pays it, idempotently, via the posting service", async () => {
    const local = await seedOrganization("AP Co");
    const orgId = local.organization.id;
    const { byCode } = local;

    const { bill } = await createBill(orgId, {
      vendor: "Acme Supplies",
      billNumber: "B-100",
      billDate: "2026-02-01",
      dueDate: "2026-03-01",
      amount: 40000n,
      apAccountId: byCode["2000"].id,
      expenseAccountId: byCode["5300"].id,
      externalId: "bill-ext-1",
    });

    // Dr expense / Cr A/P.
    const expense = await getAccountBalance(orgId, byCode["5300"].id);
    const ap = await getAccountBalance(orgId, byCode["2000"].id);
    expect(expense.balance).toBe(40000n);
    expect(ap.balance).toBe(40000n);

    // Recording the same external bill again is a no-op.
    const again = await createBill(orgId, {
      vendor: "Acme Supplies",
      billNumber: "B-100",
      billDate: "2026-02-01",
      dueDate: "2026-03-01",
      amount: 40000n,
      apAccountId: byCode["2000"].id,
      expenseAccountId: byCode["5300"].id,
      externalId: "bill-ext-1",
    });
    expect(again.bill.id).toBe(bill.id);
    expect((await getAccountBalance(orgId, byCode["2000"].id)).balance).toBe(
      40000n,
    );

    // Pay the bill in full: Dr A/P / Cr cash.
    const { bill: paidBill } = await payBill(orgId, {
      billId: bill.id,
      paymentDate: "2026-02-15",
      amount: 40000n,
      cashAccountId: byCode["1000"].id,
      externalId: "billpay-ext-1",
    });
    expect(paidBill.status).toBe("paid");
    expect((await getAccountBalance(orgId, byCode["2000"].id)).balance).toBe(0n);
    expect((await getAccountBalance(orgId, byCode["1000"].id)).balance).toBe(
      -40000n,
    );
  });
});

describe("accounts receivable & aging", () => {
  it("invoices, receives payment, and buckets outstanding by age", async () => {
    const local = await seedOrganization("AR Co");
    const orgId = local.organization.id;
    const { byCode } = local;

    // Paid-in-full invoice (drops out of aging).
    const paid = await createInvoice(orgId, {
      customer: "Customer One",
      invoiceNumber: "INV-1",
      invoiceDate: "2026-01-01",
      dueDate: "2026-01-31",
      amount: 30000n,
      arAccountId: byCode["1100"].id,
      revenueAccountId: byCode["4000"].id,
      externalId: "inv-1",
    });
    await payInvoice(orgId, {
      invoiceId: paid.invoice.id,
      paymentDate: "2026-01-20",
      amount: 30000n,
      cashAccountId: byCode["1000"].id,
      externalId: "invpay-1",
    });

    // Open, overdue invoice.
    await createInvoice(orgId, {
      customer: "Customer Two",
      invoiceNumber: "INV-2",
      invoiceDate: "2026-01-01",
      dueDate: "2026-02-01",
      amount: 50000n,
      arAccountId: byCode["1100"].id,
      revenueAccountId: byCode["4000"].id,
      externalId: "inv-2",
    });

    // Dr A/R net = 50000 (100000 raised - 50000... actually 80000 raised - 30000 collected).
    const ar = await getAccountBalance(orgId, byCode["1100"].id);
    expect(ar.balance).toBe(50000n);

    // As of 45 days after due date -> 31-60 bucket.
    const aging = await getArAging(orgId, "2026-03-18");
    expect(aging.total).toBe(50000n);
    expect(aging.buckets["31-60"]).toBe(50000n);
    expect(aging.buckets.current).toBe(0n);
    expect(aging.lines).toHaveLength(1);
    expect(aging.lines[0].invoiceNumber).toBe("INV-2");
  });
});

describe("payroll ingest (provider output only)", () => {
  it("posts gross=net+taxes and rejects an unbalanced provider run", async () => {
    const local = await seedOrganization("Payroll Co");
    const orgId = local.organization.id;
    const { byCode } = local;

    const { posted } = await postPayrollRun(orgId, {
      provider: "gusto",
      externalId: "run-2026-01",
      payDate: "2026-01-31",
      grossPay: 100000n,
      taxes: 25000n,
      netPay: 75000n,
      salariesExpenseAccountId: byCode["5200"].id,
      cashAccountId: byCode["1000"].id,
      taxLiabilityAccountId: byCode["2200"].id,
    });
    expect(posted.lines).toHaveLength(3);
    expect((await getAccountBalance(orgId, byCode["5200"].id)).balance).toBe(
      100000n,
    );
    expect((await getAccountBalance(orgId, byCode["2200"].id)).balance).toBe(
      25000n,
    );

    // Idempotent per provider run.
    const dup = await postPayrollRun(orgId, {
      provider: "gusto",
      externalId: "run-2026-01",
      payDate: "2026-01-31",
      grossPay: 100000n,
      taxes: 25000n,
      netPay: 75000n,
      salariesExpenseAccountId: byCode["5200"].id,
      cashAccountId: byCode["1000"].id,
      taxLiabilityAccountId: byCode["2200"].id,
    });
    expect(dup.posted.entry.id).toBe(posted.entry.id);

    // A provider run that does not satisfy gross = net + taxes is rejected.
    await expect(
      postPayrollRun(orgId, {
        provider: "gusto",
        externalId: "run-bad",
        payDate: "2026-02-28",
        grossPay: 100000n,
        taxes: 25000n,
        netPay: 70000n,
        salariesExpenseAccountId: byCode["5200"].id,
        cashAccountId: byCode["1000"].id,
        taxLiabilityAccountId: byCode["2200"].id,
      }),
    ).rejects.toBeInstanceOf(ImportError);
  });
});

// A small normalized QBO/Xero export used by the importer tests. Amounts are
// integer minor-unit strings. Each economic event appears exactly once.
function sampleFile(ref: string): ImportFile {
  return {
    source: "quickbooks",
    ref,
    accounts: [
      { code: "1000", name: "Cash", type: "asset" },
      { code: "1100", name: "Accounts Receivable", type: "asset" },
      { code: "2000", name: "Accounts Payable", type: "liability" },
      { code: "3000", name: "Owner's Equity", type: "equity" },
      { code: "4000", name: "Sales Revenue", type: "revenue" },
      { code: "5100", name: "Rent Expense", type: "expense" },
      { code: "5300", name: "Utilities Expense", type: "expense" },
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

describe("QBO/Xero importer + reconciliation (DoD: reproduces trial balance exactly)", () => {
  it("imports a file and the ledger trial balance matches the source exactly", async () => {
    const local = await seedOrganization("Import Co");
    const orgId = local.organization.id;

    const report = await importFile(orgId, sampleFile("file-A"), {
      actor: "importer",
    });

    expect(report.sourceBalanced).toBe(true);
    expect(report.matched).toBe(true);
    expect(report.sourceTotalDebit).toBe(report.ledgerTotalDebit);
    expect(report.sourceTotalCredit).toBe(report.ledgerTotalCredit);
    expect(report.sourceTotalDebit).toBe(report.sourceTotalCredit);
    for (const row of report.accounts) {
      expect(row.matched).toBe(true);
      expect(row.sourceDebit).toBe(row.ledgerDebit);
      expect(row.sourceCredit).toBe(row.ledgerCredit);
    }
    expect(report.invoicesCreated).toBe(1);
    expect(report.billsCreated).toBe(1);

    // The imported invoice/bill feed the sub-ledgers too.
    const aging = await getArAging(orgId, "2026-03-01");
    expect(aging.total).toBe(200000n);
  });

  it("re-importing the same file posts nothing new and still reconciles", async () => {
    const local = await seedOrganization("Reimport Co");
    const orgId = local.organization.id;

    await importFile(orgId, sampleFile("file-B"), { actor: "importer" });
    const entriesAfterFirst = await db
      .select()
      .from(journalEntriesTable)
      .where(eq(journalEntriesTable.orgId, orgId));

    const report = await importFile(orgId, sampleFile("file-B"), {
      actor: "importer",
    });
    const entriesAfterSecond = await db
      .select()
      .from(journalEntriesTable)
      .where(eq(journalEntriesTable.orgId, orgId));

    expect(entriesAfterSecond.length).toBe(entriesAfterFirst.length);
    expect(report.matched).toBe(true);
  });
});
