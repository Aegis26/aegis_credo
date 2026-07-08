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
