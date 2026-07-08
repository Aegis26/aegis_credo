/**
 * Demo: build a parent + two subsidiaries into one group, post external and
 * intercompany activity through the ledger posting service, then print the
 * consolidated trial balance, P&L, and balance sheet — showing intercompany
 * activity eliminated so the group only reflects transactions with the outside
 * world.
 *
 * Run: pnpm --filter @workspace/ledger run demo:consolidate
 */
import { pool } from "@workspace/db";
import { seedOrganization } from "./seed";
import { postJournalEntry } from "./posting";
import {
  createGroup,
  addOrgToGroup,
  getConsolidatedTrialBalance,
  getConsolidatedProfitAndLoss,
  getConsolidatedBalanceSheet,
} from "./consolidation";
import type { Money } from "./money";

function money(v: Money): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const s = abs.toString().padStart(3, "0");
  return `${neg ? "-" : ""}${s.slice(0, -2)}.${s.slice(-2)}`;
}

const pad = (s: string, n: number): string => s.padEnd(n);
const padL = (s: string, n: number): string => s.padStart(n);

async function main(): Promise<void> {
  const parent = await seedOrganization("Parent Holdings");
  const child1 = await seedOrganization("West Subsidiary");
  const child2 = await seedOrganization("East Subsidiary");

  const group = await createGroup("Consolidated Group");
  await addOrgToGroup(group.id, parent.organization.id, { actor: "demo" });
  await addOrgToGroup(group.id, child1.organization.id, { actor: "demo" });
  await addOrgToGroup(group.id, child2.organization.id, { actor: "demo" });

  // External cash sales in each entity — total 200,000.
  const externalSales: Array<[typeof parent, Money, string]> = [
    [parent, 100_000n, "p"],
    [child1, 60_000n, "c1"],
    [child2, 40_000n, "c2"],
  ];
  for (const [entity, amount, key] of externalSales) {
    await postJournalEntry(
      entity.organization.id,
      {
        entryDate: "2026-01-15",
        memo: "External cash sale",
        source: "manual",
        lines: [
          { accountId: entity.byCode["1000"].id, debit: amount },
          { accountId: entity.byCode["4000"].id, credit: amount },
        ],
      },
      { idempotencyKey: `${key}-ext`, actor: "demo" },
    );
  }

  // Intercompany: parent bills West Subsidiary 50,000 for a shared service.
  // Both legs carry the counterparty org so consolidation can eliminate them.
  await postJournalEntry(
    parent.organization.id,
    {
      entryDate: "2026-01-20",
      memo: "Intercompany service to West Subsidiary",
      source: "manual",
      lines: [
        {
          accountId: parent.byCode["1900"].id,
          debit: 50_000n,
          counterpartyOrgId: child1.organization.id,
        },
        {
          accountId: parent.byCode["4100"].id,
          credit: 50_000n,
          counterpartyOrgId: child1.organization.id,
        },
      ],
    },
    { idempotencyKey: "p-ic", actor: "demo" },
  );
  await postJournalEntry(
    child1.organization.id,
    {
      entryDate: "2026-01-20",
      memo: "Intercompany service from Parent",
      source: "manual",
      lines: [
        {
          accountId: child1.byCode["5100"].id,
          debit: 50_000n,
          counterpartyOrgId: parent.organization.id,
        },
        {
          accountId: child1.byCode["2900"].id,
          credit: 50_000n,
          counterpartyOrgId: parent.organization.id,
        },
      ],
    },
    { idempotencyKey: "c1-ic", actor: "demo" },
  );

  const tb = await getConsolidatedTrialBalance(group.id);

  console.log(`\nConsolidated group "${group.name}" — ${tb.entities.length} entities`);
  const header =
    pad("Account", 30) +
    padL("Combined", 14) +
    padL("Eliminated", 14) +
    padL("Consolidated", 16);
  console.log(header);
  console.log("-".repeat(header.length));

  const elimByCode = new Map(tb.eliminations.map((r) => [r.code, r]));
  const conByCode = new Map(tb.consolidated.map((r) => [r.code, r]));
  for (const r of tb.combined) {
    const elim = elimByCode.get(r.code);
    const con = conByCode.get(r.code);
    console.log(
      pad(`${r.code} ${r.name}`, 30) +
        padL(money(r.balance), 14) +
        padL(elim ? money(elim.balance) : "-", 14) +
        padL(con ? money(con.balance) : "0.00", 16),
    );
  }
  console.log("-".repeat(header.length));
  console.log(
    `Trial balance: Dr ${money(tb.totalDebit)} == Cr ${money(tb.totalCredit)} (diff ${money(tb.difference)})`,
  );

  const pl = await getConsolidatedProfitAndLoss(group.id);
  console.log(`\nConsolidated P&L`);
  console.log(`  Revenue      ${money(pl.revenue)}  (intercompany revenue eliminated)`);
  console.log(`  Expenses     ${money(pl.expenses)}  (intercompany expense eliminated)`);
  console.log(`  Net income   ${money(pl.netIncome)}`);

  const bs = await getConsolidatedBalanceSheet(group.id);
  console.log(`\nConsolidated Balance Sheet`);
  console.log(`  Assets                ${money(bs.assets)}  (intercompany receivable eliminated)`);
  console.log(`  Liabilities           ${money(bs.liabilities)}  (intercompany payable eliminated)`);
  console.log(`  Equity + net income   ${money(bs.equityWithIncome)}`);
  console.log(`  Balances (A = L + E): ${bs.balances ? "YES ✓" : "NO ✗"}`);

  await pool.end();
  process.exit(bs.balances && tb.difference === 0n ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
