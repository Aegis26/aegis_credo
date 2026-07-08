import { and, eq } from "drizzle-orm";
import {
  db,
  accountsTable,
  importBatchesTable,
  type AccountType,
} from "@workspace/db";
import type { Money } from "./money";
import { normalBalanceFor } from "./money";
import { ImportError } from "./errors";
import { postJournalEntry } from "./posting";
import { createInvoice } from "./ar";
import { createBill } from "./ap";
import { getTrialBalance } from "./reporting";

/**
 * Normalized shape of an accounting export from QuickBooks Online or Xero.
 * A provider-specific adapter converts a raw QBO/Xero file into this shape.
 * All monetary amounts are STRINGS of integer minor units (e.g. cents) so no
 * float ever enters the money path; they are parsed to BigInt here.
 *
 * The file is the source of truth. Every element below becomes journal
 * postings, and reconciliation proves the resulting ledger trial balance
 * reproduces the file's own totals exactly. To avoid double counting, put a
 * given economic event in exactly one place (a transaction OR an invoice OR a
 * bill OR an opening balance) — never more than one.
 */
export type ImportSource = "quickbooks" | "xero";

export interface ImportAccount {
  code: string;
  name: string;
  type: AccountType;
}

export interface ImportLine {
  accountCode: string;
  debit?: string; // minor units
  credit?: string; // minor units
}

export interface ImportTransaction {
  id: string;
  date: string; // YYYY-MM-DD
  memo?: string;
  lines: ImportLine[];
}

export interface ImportInvoice {
  id: string;
  customer: string;
  invoiceNumber?: string;
  invoiceDate: string;
  dueDate: string;
  amount: string; // minor units
  arAccountCode: string;
  revenueAccountCode: string;
}

export interface ImportBill {
  id: string;
  vendor: string;
  billNumber?: string;
  billDate: string;
  dueDate: string;
  amount: string; // minor units
  apAccountCode: string;
  expenseAccountCode: string;
}

export interface ImportFile {
  source: ImportSource;
  /** Stable ref for the source file (e.g. its content hash). */
  ref: string;
  accounts: ImportAccount[];
  openingBalances?: ImportLine[];
  transactions?: ImportTransaction[];
  openInvoices?: ImportInvoice[];
  openBills?: ImportBill[];
}

export interface ReconciliationAccountRow {
  code: string;
  name: string;
  sourceDebit: Money;
  sourceCredit: Money;
  ledgerDebit: Money;
  ledgerCredit: Money;
  matched: boolean;
}

export interface ReconciliationReport {
  source: ImportSource;
  ref: string;
  accounts: ReconciliationAccountRow[];
  sourceTotalDebit: Money;
  sourceTotalCredit: Money;
  ledgerTotalDebit: Money;
  ledgerTotalCredit: Money;
  /** Source debits equal source credits (the file is internally balanced). */
  sourceBalanced: boolean;
  /** Every account's source totals equal its ledger totals. */
  matched: boolean;
  entriesPosted: number;
  invoicesCreated: number;
  billsCreated: number;
}

function parseMinor(value: string | undefined, label: string): Money {
  if (value === undefined) return 0n;
  if (!/^-?\d+$/.test(value)) {
    throw new ImportError(
      `${label} must be an integer string of minor units, got "${value}".`,
    );
  }
  return BigInt(value);
}

type SourceTotals = Map<string, { debit: Money; credit: Money }>;

function addSource(
  totals: SourceTotals,
  code: string,
  debit: Money,
  credit: Money,
): void {
  const cur = totals.get(code) ?? { debit: 0n, credit: 0n };
  cur.debit += debit;
  cur.credit += credit;
  totals.set(code, cur);
}

/**
 * Import a normalized QBO/Xero file into the ledger through the posting service,
 * then reconcile the resulting ledger trial balance against the file's own
 * totals. Fully idempotent: every posting carries a deterministic key derived
 * from the file ref, so re-importing the same file posts nothing new and the
 * reconciliation still matches.
 */
export async function importFile(
  orgId: string,
  file: ImportFile,
  options: { actor?: string } = {},
): Promise<ReconciliationReport> {
  const actor = options.actor ?? "system";

  // 1. Record the batch (idempotent per org+ref).
  await db
    .insert(importBatchesTable)
    .values({ orgId, source: file.source, externalRef: file.ref })
    .onConflictDoNothing({
      target: [importBatchesTable.orgId, importBatchesTable.externalRef],
    });

  // 2. Ensure every account exists; build code -> id and code -> name maps.
  const accountIdByCode = new Map<string, string>();
  const nameByCode = new Map<string, string>();
  for (const acc of file.accounts) {
    nameByCode.set(acc.code, acc.name);
    const [existing] = await db
      .select()
      .from(accountsTable)
      .where(
        and(eq(accountsTable.orgId, orgId), eq(accountsTable.code, acc.code)),
      )
      .limit(1);
    if (existing) {
      accountIdByCode.set(acc.code, existing.id);
      continue;
    }
    const [created] = await db
      .insert(accountsTable)
      .values({
        orgId,
        code: acc.code,
        name: acc.name,
        type: acc.type,
        normalBalance: normalBalanceFor(acc.type),
      })
      .returning();
    accountIdByCode.set(acc.code, created.id);
  }

  const idFor = (code: string): string => {
    const id = accountIdByCode.get(code);
    if (!id) {
      throw new ImportError(`Unknown account code "${code}" referenced in file.`);
    }
    return id;
  };

  const sourceTotals: SourceTotals = new Map();
  let entriesPosted = 0;
  let invoicesCreated = 0;
  let billsCreated = 0;

  // 3. Opening balances as a single balanced entry.
  if (file.openingBalances && file.openingBalances.length > 0) {
    const lines = file.openingBalances.map((l) => {
      const debit = parseMinor(l.debit, `opening ${l.accountCode} debit`);
      const credit = parseMinor(l.credit, `opening ${l.accountCode} credit`);
      addSource(sourceTotals, l.accountCode, debit, credit);
      return { accountId: idFor(l.accountCode), debit, credit };
    });
    await postJournalEntry(
      orgId,
      {
        entryDate: earliestDate(file),
        memo: `Opening balances (${file.source})`,
        source: "import_opening",
        lines,
      },
      { actor, idempotencyKey: `import:${file.ref}:opening` },
    );
    entriesPosted += 1;
  }

  // 4. Transactions.
  for (const txn of file.transactions ?? []) {
    const lines = txn.lines.map((l) => {
      const debit = parseMinor(l.debit, `txn ${txn.id} ${l.accountCode} debit`);
      const credit = parseMinor(
        l.credit,
        `txn ${txn.id} ${l.accountCode} credit`,
      );
      addSource(sourceTotals, l.accountCode, debit, credit);
      return { accountId: idFor(l.accountCode), debit, credit };
    });
    await postJournalEntry(
      orgId,
      {
        entryDate: txn.date,
        memo: txn.memo ?? `Imported txn ${txn.id}`,
        source: "import_txn",
        lines,
      },
      { actor, idempotencyKey: `import:${file.ref}:txn:${txn.id}` },
    );
    entriesPosted += 1;
  }

  // 5. Open invoices (Dr A/R / Cr revenue) — recorded as A/R documents too.
  for (const inv of file.openInvoices ?? []) {
    const amount = parseMinor(inv.amount, `invoice ${inv.id} amount`);
    addSource(sourceTotals, inv.arAccountCode, amount, 0n);
    addSource(sourceTotals, inv.revenueAccountCode, 0n, amount);
    await createInvoice(
      orgId,
      {
        customer: inv.customer,
        invoiceNumber: inv.invoiceNumber,
        invoiceDate: inv.invoiceDate,
        dueDate: inv.dueDate,
        amount,
        arAccountId: idFor(inv.arAccountCode),
        revenueAccountId: idFor(inv.revenueAccountCode),
        externalId: `import:${file.ref}:inv:${inv.id}`,
      },
      { actor },
    );
    entriesPosted += 1;
    invoicesCreated += 1;
  }

  // 6. Open bills (Dr expense / Cr A/P) — recorded as A/P documents too.
  for (const bill of file.openBills ?? []) {
    const amount = parseMinor(bill.amount, `bill ${bill.id} amount`);
    addSource(sourceTotals, bill.expenseAccountCode, amount, 0n);
    addSource(sourceTotals, bill.apAccountCode, 0n, amount);
    await createBill(
      orgId,
      {
        vendor: bill.vendor,
        billNumber: bill.billNumber,
        billDate: bill.billDate,
        dueDate: bill.dueDate,
        amount,
        apAccountId: idFor(bill.apAccountCode),
        expenseAccountId: idFor(bill.expenseAccountCode),
        externalId: `import:${file.ref}:bill:${bill.id}`,
      },
      { actor },
    );
    entriesPosted += 1;
    billsCreated += 1;
  }

  return buildReconciliation(
    orgId,
    file,
    sourceTotals,
    nameByCode,
    entriesPosted,
    invoicesCreated,
    billsCreated,
  );
}

function earliestDate(file: ImportFile): string {
  const dates: string[] = [];
  for (const t of file.transactions ?? []) dates.push(t.date);
  for (const i of file.openInvoices ?? []) dates.push(i.invoiceDate);
  for (const b of file.openBills ?? []) dates.push(b.billDate);
  dates.sort();
  return dates[0] ?? new Date().toISOString().slice(0, 10);
}

async function buildReconciliation(
  orgId: string,
  file: ImportFile,
  sourceTotals: SourceTotals,
  nameByCode: Map<string, string>,
  entriesPosted: number,
  invoicesCreated: number,
  billsCreated: number,
): Promise<ReconciliationReport> {
  const trial = await getTrialBalance(orgId);
  const ledgerByCode = new Map(
    trial.rows.map((r) => [r.code, { debit: r.debit, credit: r.credit }]),
  );

  const codes = new Set<string>([
    ...sourceTotals.keys(),
    ...file.accounts.map((a) => a.code),
  ]);

  const accounts: ReconciliationAccountRow[] = [];
  let sourceTotalDebit = 0n;
  let sourceTotalCredit = 0n;
  let matched = true;

  for (const code of [...codes].sort()) {
    const src = sourceTotals.get(code) ?? { debit: 0n, credit: 0n };
    const led = ledgerByCode.get(code) ?? { debit: 0n, credit: 0n };
    sourceTotalDebit += src.debit;
    sourceTotalCredit += src.credit;
    const rowMatched = src.debit === led.debit && src.credit === led.credit;
    if (!rowMatched) matched = false;
    accounts.push({
      code,
      name: nameByCode.get(code) ?? code,
      sourceDebit: src.debit,
      sourceCredit: src.credit,
      ledgerDebit: led.debit,
      ledgerCredit: led.credit,
      matched: rowMatched,
    });
  }

  return {
    source: file.source,
    ref: file.ref,
    accounts,
    sourceTotalDebit,
    sourceTotalCredit,
    ledgerTotalDebit: trial.totalDebit,
    ledgerTotalCredit: trial.totalCredit,
    sourceBalanced: sourceTotalDebit === sourceTotalCredit,
    matched:
      matched &&
      sourceTotalDebit === trial.totalDebit &&
      sourceTotalCredit === trial.totalCredit,
    entriesPosted,
    invoicesCreated,
    billsCreated,
  };
}
