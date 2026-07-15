/**
 * One-off dev script: create a second org for a user and import the Craig's
 * Design Studio QuickBooks trial balance fixture into it, so consolidation can
 * be tested with two real, balanced entities.
 *
 * Run: npx tsx src/dev-seed-second-org.ts <userId>
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { db, organizationsTable, pool } from "@workspace/db";
import {
  addMember,
  importFile,
  formatMoney,
  csvToRows,
  parseQboTrialBalance,
  toImportFileInput,
} from "@workspace/ledger";

const userId = process.argv[2];
if (!userId) throw new Error("Usage: tsx src/dev-seed-second-org.ts <userId>");

const fixture = resolve(
  import.meta.dirname,
  "../../../lib/ledger/src/import-adapters/fixtures/craigs-trial-balance.csv",
);

async function main() {
  const rows = csvToRows(readFileSync(fixture, "utf8"));
  const parse = parseQboTrialBalance(rows);
  // Explicit choices for the fixture's two ambiguous accounts, matching the
  // choices a user makes in the import wizard (and the phase6 e2e test):
  // "Discounts given" is contra-revenue, "Miscellaneous" is an expense.
  const draft = toImportFileInput(parse, {
    "Discounts given": "revenue",
    Miscellaneous: "expense",
  });

  // Deliberately NOT seeding the starter chart of accounts: the import creates
  // every account from the file, and pre-seeded codes could collide.
  const [org] = await db
    .insert(organizationsTable)
    .values({ name: parse.companyName ?? "Craig's Design Studio" })
    .returning();
  await addMember(org.id, userId, "owner", { actor: userId });

  const report = await importFile(
    org.id,
    { ...draft, ref: "craigs-trial-balance-fixture" },
    { actor: userId },
  );
  console.log(
    JSON.stringify(
      {
        orgId: org.id,
        orgName: org.name,
        sourceBalanced: report.sourceBalanced,
        matched: report.matched,
        entriesPosted: report.entriesPosted,
        sourceTotalDebit: formatMoney(report.sourceTotalDebit),
        sourceTotalCredit: formatMoney(report.sourceTotalCredit),
        ledgerTotalDebit: formatMoney(report.ledgerTotalDebit),
        ledgerTotalCredit: formatMoney(report.ledgerTotalCredit),
        mismatchedAccounts: report.accounts.filter((r) => !r.matched).length,
      },
      null,
      2,
    ),
  );
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
