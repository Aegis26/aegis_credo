import { createHash } from "node:crypto";
import { and, eq, gte, lt } from "drizzle-orm";
import { db, organizationsTable, accountsTable, journalEntriesTable, journalLinesTable, billsTable, billPaymentsTable } from "@workspace/db";
import { formatMoney } from "@workspace/ledger";
import type { TaxDraftInput, TaxDraftReview } from "@workspace/api-zod";
import { HttpError } from "./errors";

export const TAX_DISCLAIMER = "DRAFT — FOR REVIEW ONLY. Verify all figures and consult your tax professional before filing.";
export const SCHEDULE_LINES: Record<string, string> = {
  "8": "Advertising", "10": "Commissions and fees", "11": "Contract labor",
  "15": "Insurance (other than health)", "16a": "Mortgage interest", "16b": "Other interest",
  "17": "Legal and professional services", "18": "Office expense",
  "20a": "Vehicle / equipment rent", "20b": "Other business rent", "21": "Repairs and maintenance",
  "22": "Supplies", "23": "Taxes and licenses", "24a": "Travel",
  "24b": "Meals — recorded amount, no deduction adjustment", "25": "Utilities",
  "26": "Wages", other: "Other — owner classification required",
};
export const NEC_THRESHOLDS: Record<number, bigint> = { 2024: 60000n, 2025: 60000n, 2026: 200000n };

export interface TaxSource {
  org: { id: string; name: string; baseCurrency: string };
  accounts: { id: string; code: string; name: string; type: string }[];
  entries: { id: string; entryDate: string; reversesEntryId: string | null; source: string }[];
  lines: { entryId: string; accountId: string; debit: bigint; credit: bigint }[];
  payments: { id: string; vendor: string; paymentDate: string; amount: bigint; postedEntryId: string | null; cashAccountId: string; expenseAccountId: string; billEntryId: string | null }[];
}

export function taxYearBounds(year: number) {
  if (!Number.isInteger(year) || !NEC_THRESHOLDS[year] || year > new Date().getUTCFullYear())
    throw new HttpError(400, "Supported tax years: 2024–2026, through the current calendar year. Future thresholds are not assumed.");
  return { from: `${year}-01-01`, until: `${year + 1}-01-01` };
}

/** Repeatable, read-only snapshot. No posting, profile storage, or document storage. */
export async function loadTaxSource(orgId: string, year: number): Promise<TaxSource> {
  const { from, until } = taxYearBounds(year);
  return db.transaction(async tx => {
    const [org] = await tx.select({ id: organizationsTable.id, name: organizationsTable.name, baseCurrency: organizationsTable.baseCurrency })
      .from(organizationsTable).where(eq(organizationsTable.id, orgId));
    if (!org) throw new HttpError(404, "Organization not found.");
    const accounts = await tx.select({ id: accountsTable.id, code: accountsTable.code, name: accountsTable.name, type: accountsTable.type })
      .from(accountsTable).where(eq(accountsTable.orgId, orgId)).orderBy(accountsTable.id);
    const entries = await tx.select({ id: journalEntriesTable.id, entryDate: journalEntriesTable.entryDate, reversesEntryId: journalEntriesTable.reversesEntryId, source: journalEntriesTable.source })
      .from(journalEntriesTable).where(and(eq(journalEntriesTable.orgId, orgId), gte(journalEntriesTable.entryDate, from), lt(journalEntriesTable.entryDate, until))).orderBy(journalEntriesTable.id);
    const lines = await tx.select({ entryId: journalLinesTable.entryId, accountId: journalLinesTable.accountId, debit: journalLinesTable.debit, credit: journalLinesTable.credit })
      .from(journalLinesTable).innerJoin(journalEntriesTable, and(eq(journalLinesTable.entryId, journalEntriesTable.id), eq(journalEntriesTable.orgId, orgId)))
      .where(and(eq(journalLinesTable.orgId, orgId), gte(journalEntriesTable.entryDate, from), lt(journalEntriesTable.entryDate, until)))
      .orderBy(journalLinesTable.id);
    const payments = await tx.select({
      id: billPaymentsTable.id, vendor: billsTable.vendor, paymentDate: billPaymentsTable.paymentDate,
      amount: billPaymentsTable.amount, postedEntryId: billPaymentsTable.postedEntryId,
      cashAccountId: billPaymentsTable.cashAccountId, expenseAccountId: billsTable.expenseAccountId, billEntryId: billsTable.postedEntryId,
    }).from(billPaymentsTable).innerJoin(billsTable, and(eq(billPaymentsTable.billId, billsTable.id), eq(billsTable.orgId, orgId)))
      .where(and(eq(billPaymentsTable.orgId, orgId), gte(billPaymentsTable.paymentDate, from), lt(billPaymentsTable.paymentDate, until))).orderBy(billPaymentsTable.id);
    return { org, accounts, entries, lines, payments };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

export function buildTaxReview(source: TaxSource, input: TaxDraftInput): TaxDraftReview {
  const bounds = taxYearBounds(input.year);
  // Defend the pure boundary too; never include out-of-year sources in a review.
  const entries = source.entries.filter(e => e.entryDate >= bounds.from && e.entryDate < bounds.until);
  const entryIds = new Set(entries.map(e => e.id));
  const lines = source.lines.filter(l => entryIds.has(l.entryId));
  const warnings = [
    "Payer/payee TINs and addresses are not collected or stored. Missing — complete before filing.",
    "Ledger-only figures, not tax advice or tax owed. Verify accounting basis, entity eligibility, mappings and all amounts.",
    "NEC eligibility and payment method are unknown until reviewed. Card and qualifying third-party-network payments must not be included.",
  ];
  if (source.org.baseCurrency !== "USD") warnings.push("Non-USD ledger: no currency conversion is performed. 1099-NEC generation is unavailable.");
  const digest = createHash("sha256").update(JSON.stringify({ year: input.year, source }, (_k, v) => typeof v === "bigint" ? v.toString() : v)).digest("hex");
  const accounts = source.accounts.map(a => {
    const own = lines.filter(l => l.accountId === a.id);
    const debits = own.reduce((s, l) => s + l.debit, 0n);
    const credits = own.reduce((s, l) => s + l.credit, 0n);
    return { ...a, amount: formatMoney(a.type === "revenue" || a.type === "liability" ? credits - debits : debits - credits),
      debits: formatMoney(debits), credits: formatMoney(credits), entryIds: [...new Set(own.map(l => l.entryId))] };
  });
  const confirmed = new Set(input.confirmedPaymentIds ?? []);
  const seen = new Set<string>();
  const covered = new Set<string>();
  const groups = new Map<string, { vendor: string; total: bigint; confirmedTotal: bigint; payments: TaxDraftReview["candidates"][number]["payments"] }>();
  const selectable = new Set<string>();
  for (const p of source.payments.filter(p => p.paymentDate >= bounds.from && p.paymentDate < bounds.until)) {
    if (p.billEntryId) covered.add(p.billEntryId);
    const id = p.postedEntryId;
    if (!id || !entryIds.has(id)) {
      warnings.push(`Payment ${p.id} has no same-year ledger posting; excluded until reconciled.`);
      continue;
    }
    if (seen.has(id)) { warnings.push(`Duplicate source posting ${id} excluded (payment ${p.id}).`); continue; }
    seen.add(id); covered.add(id);
    const reversals = entries.filter(e => e.reversesEntryId === id);
    reversals.forEach(e => covered.add(e.id));
    const related = new Set([id, ...reversals.map(e => e.id)]);
    const originalCash = lines.filter(l => l.entryId === id && l.accountId === p.cashAccountId)
      .reduce((s, l) => s + l.credit - l.debit, 0n);
    const net = lines.filter(l => related.has(l.entryId) && l.accountId === p.cashAccountId)
      .reduce((s, l) => s + l.credit - l.debit, 0n);
    if (originalCash !== p.amount || net < 0n || net > p.amount) {
      warnings.push(`Payment ${p.id} does not reconcile to its ledger cash movement; excluded.`);
      continue;
    }
    if (net === 0n) { warnings.push(`Reversed payment ${p.id}: zero net paid in this tax year; excluded.`); continue; }
    const vendor = p.vendor.trim();
    if (!vendor) { warnings.push(`Payment ${p.id} is missing vendor identity; excluded.`); continue; }
    selectable.add(p.id);
    const group = groups.get(vendor) ?? { vendor, total: 0n, confirmedTotal: 0n, payments: [] };
    group.total += net;
    if (confirmed.has(p.id)) group.confirmedTotal += net;
    group.payments.push({ id: p.id, date: p.paymentDate, amount: formatMoney(net), entryId: id,
      accountName: source.accounts.find(a => a.id === p.expenseAccountId)?.name ?? "Unresolved expense account",
      confirmed: confirmed.has(p.id), warnings: [
        "Confirm contractor services, legal recipient identity and eligible payment method; exclude goods, card/network payments and reimbursements not reportable here.",
        ...(reversals.length ? ["Net amount includes linked same-year reversal."] : []),
      ] });
    groups.set(vendor, group);
  }
  if ([...confirmed].some(id => !selectable.has(id))) throw new HttpError(400, "Selected payment is unavailable in this organization/year or has unresolved ledger linkage.");
  const mappings = input.mappings ?? [];
  if (new Set(mappings.map(m => m.accountId)).size !== mappings.length) throw new HttpError(400, "Map each expense account only once.");
  for (const m of mappings) if (!SCHEDULE_LINES[m.line] || !accounts.some(a => a.id === m.accountId && a.type === "expense"))
    throw new HttpError(400, "Invalid expense account or Schedule C mapping for this organization.");
  for (const [ids, type] of [[input.salesAccountIds ?? [], "revenue"], [input.salesTaxAccountIds ?? [], "liability"]] as const)
    if (new Set(ids).size !== ids.length || ids.some(id => !accounts.some(a => a.id === id && a.type === type)))
      throw new HttpError(400, "Invalid sales account selection for this organization.");
  const expenseIds = new Set(source.accounts.filter(a => a.type === "expense").map(a => a.id));
  const unresolvedEntries = new Set(lines.filter(l => expenseIds.has(l.accountId) && !covered.has(l.entryId)).map(l => l.entryId)).size;
  const unresolvedReversals = entries.filter(e => e.reversesEntryId && !covered.has(e.id));
  for (const e of unresolvedReversals)
    warnings.push(`Reversal ${e.id} is not attributed to a selected-year bill payment. Review prior-year refunds/adjustments separately; no recipient is inferred.`);
  if (unresolvedEntries) warnings.push(`${unresolvedEntries} expense ledger entries have no linked named bill payment; review separately. No contractor is inferred from descriptions.`);
  return { orgName: source.org.name, year: input.year, currency: source.org.baseCurrency,
    threshold: formatMoney(NEC_THRESHOLDS[input.year]!), disclaimer: TAX_DISCLAIMER, sourceDigest: digest, warnings, unresolvedEntries,
    accounts, candidates: [...groups.values()].sort((a,b) => a.vendor.localeCompare(b.vendor)).map(g => ({
      vendor: g.vendor, total: formatMoney(g.total), confirmedTotal: formatMoney(g.confirmedTotal),
      aboveThreshold: g.total >= NEC_THRESHOLDS[input.year]!, payments: g.payments,
    })) };
}
