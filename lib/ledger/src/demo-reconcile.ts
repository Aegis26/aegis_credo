/**
 * Demo: import a sample QuickBooks/Xero export into a fresh org through the
 * ledger posting service, then print the reconciliation report proving the
 * ledger's trial balance reproduces the source file's totals exactly.
 *
 * Run: pnpm --filter @workspace/ledger run demo:reconcile
 */
import { pool } from "@workspace/db";
import { seedOrganization } from "./seed";
import { importFile, type ImportFile } from "./import";
import { getArAging } from "./ar";
import type { Money } from "./money";

function money(v: Money): string {
  // Minor units -> major units with 2 decimals, for display only.
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const s = abs.toString().padStart(3, "0");
  const major = s.slice(0, -2);
  const minor = s.slice(-2);
  return `${neg ? "-" : ""}${major}.${minor}`;
}

const sampleFile: ImportFile = {
  source: "quickbooks",
  ref: `demo-${Date.now()}`,
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

async function main(): Promise<void> {
  const org = await seedOrganization("Reconciliation Demo Co");
  const report = await importFile(org.organization.id, sampleFile, {
    actor: "demo-importer",
  });

  const pad = (s: string, n: number): string => s.padEnd(n);
  const padL = (s: string, n: number): string => s.padStart(n);

  console.log(`\nReconciliation report — ${report.source} (ref ${report.ref})`);
  console.log(
    `Posted ${report.entriesPosted} entries · ${report.invoicesCreated} invoice(s) · ${report.billsCreated} bill(s)\n`,
  );

  const header =
    pad("Account", 26) +
    padL("Source Dr", 14) +
    padL("Source Cr", 14) +
    padL("Ledger Dr", 14) +
    padL("Ledger Cr", 14) +
    padL("Match", 8);
  console.log(header);
  console.log("-".repeat(header.length));
  for (const r of report.accounts) {
    console.log(
      pad(`${r.code} ${r.name}`, 26) +
        padL(money(r.sourceDebit), 14) +
        padL(money(r.sourceCredit), 14) +
        padL(money(r.ledgerDebit), 14) +
        padL(money(r.ledgerCredit), 14) +
        padL(r.matched ? "OK" : "MISMATCH", 8),
    );
  }
  console.log("-".repeat(header.length));
  console.log(
    pad("TOTALS", 26) +
      padL(money(report.sourceTotalDebit), 14) +
      padL(money(report.sourceTotalCredit), 14) +
      padL(money(report.ledgerTotalDebit), 14) +
      padL(money(report.ledgerTotalCredit), 14) +
      padL(report.matched ? "OK" : "MISMATCH", 8),
  );

  console.log(
    `\nSource balanced (Dr == Cr): ${report.sourceBalanced ? "yes" : "no"}`,
  );
  console.log(
    `Ledger reproduces source exactly: ${report.matched ? "YES ✓" : "NO ✗"}`,
  );

  const aging = await getArAging(org.organization.id, "2026-03-01");
  console.log(`\nA/R aging as of ${aging.asOf} — total ${money(aging.total)}`);
  for (const [bucket, amount] of Object.entries(aging.buckets)) {
    console.log(`  ${pad(bucket, 8)} ${money(amount)}`);
  }

  await pool.end();
  process.exit(report.matched ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
