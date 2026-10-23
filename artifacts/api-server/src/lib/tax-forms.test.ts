import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { buildTaxReview, taxYearBounds, TAX_DISCLAIMER, type TaxSource } from "./tax-forms";
import { generateTaxPdf } from "./tax-forms-pdf";

function fixture(): TaxSource {
  return {
    org: { id: "org", name: "Example Review Business", baseCurrency: "USD" },
    accounts: [
      { id: "cash", code: "1000", name: "Cash", type: "asset" },
      { id: "expense", code: "5100", name: "Contract labor", type: "expense" },
      { id: "sales", code: "4100", name: "Sales", type: "revenue" },
      { id: "tax", code: "2100", name: "Recorded sales tax", type: "liability" },
    ],
    entries: [{ id: "paid", entryDate: "2026-01-01", reversesEntryId: null, source: "bill_payment" }],
    lines: [{ entryId: "paid", accountId: "cash", credit: 200000n, debit: 0n }],
    payments: [{ id: "p1", vendor: "Example Contractor", paymentDate: "2026-01-01", amount: 200000n, cashAccountId: "cash", expenseAccountId: "expense", billEntryId: "bill", postedEntryId: "paid" }],
  };
}
describe("tax draft source integrity", () => {
  it("uses exact year bounds and rejects unknown future thresholds", () => {
    expect(taxYearBounds(2025)).toEqual({ from: "2025-01-01", until: "2026-01-01" });
    expect(() => taxYearBounds(2027)).toThrow(/Supported tax years/);
  });
  it("uses year-specific thresholds and includes below-threshold candidates for owner review", () => {
    const s = fixture();
    expect(buildTaxReview(s, { year: 2026 }).threshold).toBe("2000.00");
    s.payments[0]!.amount = 60000n; s.lines[0]!.credit = 60000n;
    const r = buildTaxReview(s, { year: 2026 });
    expect(r.candidates[0]).toMatchObject({ total: "600.00", aboveThreshold: false, confirmedTotal: "0.00" });
    s.entries[0]!.entryDate = "2025-12-31"; s.payments[0]!.paymentDate = "2025-12-31";
    expect(buildTaxReview(s, { year: 2025 }).candidates[0]?.aboveThreshold).toBe(true);
  });
  it("includes Jan 1 and Dec 31 but excludes the next year's January 1", () => {
    const s = fixture();
    for (const [id, date] of [["end", "2026-12-31"], ["next", "2027-01-01"], ["prior", "2025-12-31"]]) {
      s.entries.push({ id: id!, entryDate: date!, reversesEntryId: null, source: "bill_payment" });
      s.lines.push({ entryId: id!, accountId: "cash", debit: 0n, credit: 100n });
      s.payments.push({ ...s.payments[0]!, id: id!, postedEntryId: id!, paymentDate: date!, amount: 100n });
    }
    expect(buildTaxReview(s, { year: 2026 }).candidates[0]?.total).toBe("2001.00");
  });
  it("deduplicates the same ledger payment posting and requires explicit eligibility confirmation", () => {
    const s = fixture(); s.payments.push({ ...s.payments[0]!, id: "duplicate" });
    const r = buildTaxReview(s, { year: 2026, confirmedPaymentIds: ["p1"] });
    expect(r.candidates[0]).toMatchObject({ total: "2000.00", confirmedTotal: "2000.00" });
    expect(r.candidates[0]?.payments).toHaveLength(1);
    expect(r.warnings.join(" ")).toMatch(/Duplicate/);
    expect(() => buildTaxReview(s, { year: 2026, confirmedPaymentIds: ["duplicate"] })).toThrow(/unavailable/);
  });
  it("nets linked reversals and rejects unmatched cash totals", () => {
    const s = fixture();
    s.entries.push({ id: "reversed", entryDate: "2026-05-01", reversesEntryId: "paid", source: "reversal" });
    s.lines.push({ entryId: "reversed", accountId: "cash", debit: 200000n, credit: 0n });
    expect(buildTaxReview(s, { year: 2026 }).candidates).toHaveLength(0);
    s.lines.pop(); s.entries.pop(); s.lines[0]!.credit = 199999n;
    expect(buildTaxReview(s, { year: 2026 }).warnings.join(" ")).toMatch(/does not reconcile/);
  });
  it("keeps large amounts exact and never derives 1099 payments from accrual expenses", () => {
    const s = fixture(); const amount = 900719925474099301n;
    s.lines[0]!.credit = amount; s.payments[0]!.amount = amount;
    s.entries.push({ id: "accrual", entryDate: "2026-06-01", reversesEntryId: null, source: "bill" });
    s.lines.push({ entryId: "accrual", accountId: "expense", debit: 999n, credit: 0n });
    const r = buildTaxReview(s, { year: 2026, confirmedPaymentIds: ["p1"] });
    expect(r.candidates[0]?.confirmedTotal).toBe("9007199254740993.01");
    expect(r.unresolvedEntries).toBe(1);
    expect(r.accounts.find(a => a.id === "expense")?.amount).toBe("9.99");
  });
  it("rejects foreign selections and duplicate/unknown account mappings", () => {
    const s = fixture();
    expect(() => buildTaxReview(s, { year: 2026, confirmedPaymentIds: ["foreign"] })).toThrow();
    expect(() => buildTaxReview(s, { year: 2026, mappings: [{ accountId: "foreign", line: "11" }] })).toThrow();
    expect(() => buildTaxReview(s, { year: 2026, mappings: [{ accountId: "expense", line: "depreciation" }] })).toThrow();
    expect(() => buildTaxReview(s, { year: 2026, salesAccountIds: ["foreign"] })).toThrow();
    expect(() => buildTaxReview(s, { year: 2026, salesTaxAccountIds: ["sales"] })).toThrow();
  });
  it("snapshot digest changes when underlying ledger amounts change, not review selections", () => {
    const s = fixture(); const before = buildTaxReview(s, { year: 2026 });
    expect(buildTaxReview(s, { year: 2026, confirmedPaymentIds: ["p1"] }).sourceDigest).toBe(before.sourceDigest);
    s.lines[0]!.credit += 1n;
    expect(buildTaxReview(s, { year: 2026 }).sourceDigest).not.toBe(before.sourceDigest);
  });
});

describe("real review PDFs", () => {
  async function pageTexts(bytes: Uint8Array) {
    const task = getDocument({ data: bytes.slice(), useSystemFonts: true });
    const doc = await task.promise;
    const texts: string[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const content = await (await doc.getPage(p)).getTextContent();
      texts.push(content.items.map(i => "str" in i ? i.str : "").join(" "));
    }
    await task.destroy();
    return texts;
  }
  it.each([2024, 2025, 2026])("uses the official %s layout and leaves missing fields blank with flags", async year => {
    const s = fixture(); s.entries[0]!.entryDate = `${year}-01-01`; s.payments[0]!.paymentDate = `${year}-01-01`;
    const r = buildTaxReview(s, { year, confirmedPaymentIds: ["p1"] });
    const bytes = await generateTaxPdf(r, { year, kind: "nec", vendor: "Example Contractor" });
    if (process.env.TAX_PDF_REVIEW_DIR) await writeFile(path.join(process.env.TAX_PDF_REVIEW_DIR, `sample-${year}.pdf`), bytes);
    const pages = await pageTexts(bytes);
    expect(pages[0]).toContain("Nonemployee");
    expect(pages[0]).toContain("Example Contractor");
    expect(pages[0]).toContain("2000.00");
    expect(pages[0]).toContain(year === 2026 ? "1a" : "compensation");
    expect(pages[0]).toContain("Missing");
    expect(pages.every(p => p.includes("DRAFT") && p.includes("Verify all figures and consult your tax professional before filing."))).toBe(true);
    expect((await PDFDocument.load(bytes)).getForm().getFields()).toHaveLength(0);
  });
  it("paginates long sources with disclaimers on every page", async () => {
    const s = fixture();
    s.accounts.push(...Array.from({ length: 55 }, (_, i) => ({ id: `a${i}`, name: `Expense ${i}`, code: `${5101 + i}`, type: "expense" })));
    const r = buildTaxReview(s, { year: 2026 });
    const pages = await pageTexts(await generateTaxPdf(r, { year: 2026, kind: "schedule-c", mappings: [{ accountId: "expense", line: "11" }] }));
    expect(pages.length).toBeGreaterThan(3);
    expect(pages.every(p => p.includes("DRAFT") && p.includes("Verify all figures and consult your tax professional before filing."))).toBe(true);
    expect(pages.join(" ")).toContain("UNMAPPED");
    expect(TAX_DISCLAIMER).toContain("FOR REVIEW ONLY");
  });
  it("reports insufficient sales-tax data instead of calculating tax owed", async () => {
    const r = buildTaxReview(fixture(), { year: 2026 });
    const text = (await pageTexts(await generateTaxPdf(r, { year: 2026, kind: "sales-tax" }))).join(" ");
    expect(text).toContain("INSUFFICIENT RECORDED DATA");
    expect(text).toContain("NOT TAX OWED");
  });
  it("rejects unconfirmed NEC amounts and non-USD NEC", async () => {
    const s = fixture(); const r = buildTaxReview(s, { year: 2026 });
    await expect(generateTaxPdf(r, { year: 2026, kind: "nec", vendor: "Example Contractor" })).rejects.toThrow(/confirm/);
    s.org.baseCurrency = "EUR";
    await expect(generateTaxPdf(buildTaxReview(s, { year: 2026, confirmedPaymentIds: ["p1"] }), { year: 2026, kind: "nec", vendor: "Example Contractor" })).rejects.toThrow(/USD/);
  });
});
