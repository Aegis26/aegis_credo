import { describe, it, expect, afterAll } from "vitest";
import { and, eq, isNotNull } from "drizzle-orm";
import { db, pool, journalEntriesTable } from "@workspace/db";
import { seedOrganization } from "./seed";
import {
  importFile,
  findUnreversedOpeningImports,
  type ImportFile,
} from "./import";
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

describe("multi-import guard (opening balances never silently stack)", () => {
  it("blocks importing a DIFFERENT file into an org that already has opening balances", async () => {
    const { organization } = await seedOrganization("Guard Block Co");
    const orgId = organization.id;

    await importFile(orgId, openingFile("guard-a", "500000"), {
      actor: "importer",
    });

    const before = await db
      .select()
      .from(journalEntriesTable)
      .where(eq(journalEntriesTable.orgId, orgId));

    await expect(
      importFile(orgId, openingFile("guard-b", "700000"), {
        actor: "importer",
      }),
    ).rejects.toBeInstanceOf(ImportOpeningConflictError);

    // Nothing was posted — the books were NOT doubled.
    const after = await db
      .select()
      .from(journalEntriesTable)
      .where(eq(journalEntriesTable.orgId, orgId));
    expect(after.length).toBe(before.length);

    const tb = await getTrialBalance(orgId);
    expect(tb.totalDebit).toBe(500000n);
    expect(tb.totalCredit).toBe(500000n);
  });

  it("re-importing the SAME file stays idempotent (no guard, nothing new posted)", async () => {
    const { organization } = await seedOrganization("Guard Idempotent Co");
    const orgId = organization.id;

    await importFile(orgId, openingFile("guard-same", "300000"), {
      actor: "importer",
    });
    const before = await db
      .select()
      .from(journalEntriesTable)
      .where(eq(journalEntriesTable.orgId, orgId));

    const report = await importFile(orgId, openingFile("guard-same", "300000"), {
      actor: "importer",
    });
    expect(report.matched).toBe(true);

    const after = await db
      .select()
      .from(journalEntriesTable)
      .where(eq(journalEntriesTable.orgId, orgId));
    expect(after.length).toBe(before.length);
  });

  it("replace reverses the prior opening entries (audit trail intact) and posts the new ones", async () => {
    const { organization } = await seedOrganization("Guard Replace Co");
    const orgId = organization.id;

    await importFile(orgId, openingFile("guard-old", "500000"), {
      actor: "importer",
    });
    const [oldOpening] = await findUnreversedOpeningImports(orgId);
    expect(oldOpening).toBeTruthy();

    const report = await importFile(orgId, openingFile("guard-new", "800000"), {
      actor: "importer",
      onExistingOpening: "replace",
    });

    // Reconciliation matches the NEW file exactly.
    expect(report.matched).toBe(true);
    expect(report.sourceTotalDebit).toBe(800000n);

    // The final trial balance equals the new file, not old + new.
    const tb = await getTrialBalance(orgId);
    expect(tb.totalDebit).toBe(tb.totalCredit);
    const cashRow = tb.rows.find((r) => r.code === "1000");
    expect((cashRow?.debit ?? 0n) - (cashRow?.credit ?? 0n)).toBe(800000n);

    // The original opening entry is still in the ledger, now reversed.
    const [original] = await db
      .select()
      .from(journalEntriesTable)
      .where(
        and(
          eq(journalEntriesTable.orgId, orgId),
          eq(journalEntriesTable.id, oldOpening.id),
        ),
      );
    expect(original).toBeTruthy();
    const [reversal] = await db
      .select()
      .from(journalEntriesTable)
      .where(
        and(
          eq(journalEntriesTable.orgId, orgId),
          eq(journalEntriesTable.reversesEntryId, oldOpening.id),
        ),
      );
    expect(reversal).toBeTruthy();

    // Only the NEW opening entry remains un-reversed.
    const remaining = await findUnreversedOpeningImports(orgId);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].idempotencyKey).toBe("import:guard-new:opening");

    // Reversal entries exist and are flagged as reversals (append-only).
    const reversals = await db
      .select()
      .from(journalEntriesTable)
      .where(
        and(
          eq(journalEntriesTable.orgId, orgId),
          isNotNull(journalEntriesTable.reversesEntryId),
        ),
      );
    expect(reversals.length).toBe(1);
  });
});
