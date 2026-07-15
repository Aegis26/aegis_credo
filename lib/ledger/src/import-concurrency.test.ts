import { describe, it, expect, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { db, pool, journalEntriesTable } from "@workspace/db";
import { seedOrganization } from "./seed";
import { importFile, type ImportFile } from "./import";
import { ImportOpeningConflictError } from "./errors";
import { getTrialBalance } from "./reporting";

afterAll(async () => {
  await pool.end();
});

function openingFile(ref: string, cash: string): ImportFile {
  return {
    source: "quickbooks",
    ref,
    accounts: [
      { code: "1000", name: "Cash", type: "asset" },
      { code: "3000", name: "Owner's Equity", type: "equity" },
    ],
    openingBalances: [
      { accountCode: "1000", debit: cash },
      { accountCode: "3000", credit: cash },
    ],
  };
}

describe("multi-import guard under concurrency", () => {
  it("two PARALLEL imports with different refs: exactly one wins, the other is blocked", async () => {
    const { organization } = await seedOrganization("Guard Race Co");
    const orgId = organization.id;

    const results = await Promise.allSettled([
      importFile(orgId, openingFile("race-a", "500000"), { actor: "a" }),
      importFile(orgId, openingFile("race-b", "700000"), { actor: "b" }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(
      (rejected[0] as PromiseRejectedResult).reason,
    ).toBeInstanceOf(ImportOpeningConflictError);

    // Exactly ONE opening entry exists — the books were never doubled.
    const openings = await db
      .select()
      .from(journalEntriesTable)
      .where(
        and(
          eq(journalEntriesTable.orgId, orgId),
          eq(journalEntriesTable.source, "import_opening"),
        ),
      );
    expect(openings).toHaveLength(1);

    const tb = await getTrialBalance(orgId);
    expect(tb.totalDebit).toBe(tb.totalCredit);
    expect([500000n, 700000n]).toContain(tb.totalDebit);
  });
});
