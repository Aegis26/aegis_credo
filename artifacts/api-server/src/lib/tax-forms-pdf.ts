import { readFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { TaxDraftInput, TaxDraftReview } from "@workspace/api-zod";
import { formatMoney } from "@workspace/ledger";
import { parseMoney } from "./money";
import { HttpError } from "./errors";
import { SCHEDULE_LINES, TAX_DISCLAIMER } from "./tax-forms";

// Both source execution (tests) and the production bundled entrypoint resolve
// the same pinned assets; build.mjs copies them into dist/assets.
const assetDir = path.resolve(import.meta.dirname, "../../assets/tax-forms");
const bundledAssetDir = path.resolve(import.meta.dirname, "assets/tax-forms");

function printable(value: string, font: PDFFont): string {
  try { font.encodeText(value); return value; }
  catch { return "[Text unavailable in PDF font - see source review; complete manually]"; }
}

async function templateBytes(year: number) {
  const name = `1099-nec-${year}.pdf`;
  try { return await readFile(path.join(assetDir, name)); }
  catch { return readFile(path.join(bundledAssetDir, name)); }
}

/** PDFs are generated in memory and returned to this owner only, not persisted. */
export async function generateTaxPdf(review: TaxDraftReview, input: TaxDraftInput): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Credo ${input.kind} ${review.year} DRAFT`);
  pdf.setSubject("Ledger transcription only - not tax preparation or filing");
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page: PDFPage;
  let y = 0;
  function newPage(title: string) {
    page = pdf.addPage([612, 792]);
    page.drawRectangle({ x: 24, y: 739, width: 564, height: 36, color: rgb(1, .94, .9) });
    page.drawText("DRAFT — FOR REVIEW ONLY.", { x: 32, y: 759, font: bold, size: 11, color: rgb(.6, .12, .08) });
    page.drawText("Verify all figures and consult your tax professional before filing.", { x: 32, y: 745, font, size: 9 });
    page.drawText("DRAFT — FOR REVIEW ONLY. Not filing-ready. Verify all figures before use.", { x: 30, y: 22, font, size: 8 });
    page.drawText(`${pdf.getPageCount()}`, { x: 568, y: 22, font, size: 8 });
    y = 716;
    text(title, true);
  }
  function text(value: string, strong = false) {
    const clean = printable(value.replace(/[\r\n\t]+/g, " "), font);
    // Bounded wrapping also prevents a long unbroken ID/name overflowing.
    const words = clean.match(/.{1,92}(?:\s|$)|.{1,92}/g) ?? [clean];
    for (const part of words) {
      if (y < 58) newPage("Continued — ledger review");
      page.drawText(part.trim(), { x: 32, y, font: strong ? bold : font, size: strong ? 11 : 9 });
      y -= strong ? 19 : 14;
    }
  }
  function metadata() {
    text(`${review.orgName} | Tax year ${review.year} | Ledger currency ${review.currency}`);
    text(`Generated ${new Date().toISOString()}`);
    text("Missing — complete before filing: payer legal name confirmation, payer TIN/address.");
    text("Owner review only. No calculation of tax owed, no e-filing, no agency submission.");
  }
  function sources(accounts: TaxDraftReview["accounts"]) {
    newPage("Ledger sources — account and entry references");
    metadata();
    text(`Source snapshot: ${review.sourceDigest}`);
    for (const a of accounts) {
      text(`${a.code} ${a.name}: ${a.amount} ${review.currency}`, true);
      text(`Account ${a.id}`);
      text(`Entries: ${a.entryIds.join(", ") || "No posted activity in selected year"}`);
    }
  }

  if (input.kind === "nec") {
    if (review.currency !== "USD") throw new HttpError(409, "1099-NEC requires USD ledger figures; no currency conversion is provided.");
    const candidate = review.candidates.find(c => c.vendor === input.vendor);
    if (!candidate || parseMoney(candidate.confirmedTotal) <= 0n)
      throw new HttpError(409, "Select a recipient and confirm eligible ledger payments before downloading.");
    const template = await PDFDocument.load(await templateBytes(review.year));
    const form = template.getForm();
    const missing: string[] = [];
    function fill(suffix: string, value: string) {
      const f = form.getFields().find(f => f.getName().includes(".CopyB[") && f.getName().endsWith(`.${suffix}[0]`));
      if (!f) throw new Error("Pinned IRS PDF field is unavailable.");
      try {
        font.encodeText(value);
        const tf = form.getTextField(f.getName());
        tf.setFontSize(9);
        tf.setText(value);
      } catch { missing.push(`${suffix}: text could not be represented; complete manually.`); }
    }
    fill("f2_1", String(review.year));
    fill("f2_2", review.orgName);
    fill(review.year === 2026 ? "f2_12" : "f2_5", candidate.vendor);
    fill(review.year === 2026 ? "f2_20" : "f2_9", candidate.confirmedTotal);
    // Names exceeding a field's visible width are flagged rather than silently trusted.
    if (font.widthOfTextAtSize(printable(review.orgName, font), 9) > 230 || font.widthOfTextAtSize(printable(candidate.vendor, font), 9) > 230)
      missing.push("Long legal name: inspect field wrapping and complete official form manually.");
    form.updateFieldAppearances(await template.embedFont(StandardFonts.Helvetica));
    form.flatten();
    const [irsPage] = await pdf.embedPages([template.getPages()[3]!]);
    newPage(`1099-NEC ${review.year} — recipient review copy`);
    // Official Copy B geometry remains intact, with disclaimer outside the form.
    page!.drawPage(irsPage!, { x: 18, y: -20, width: 576, height: 745.4 });
    y = review.year === 2026 ? 345 : 455;
    text("NOT FOR SUBMISSION — watermarked draft, not IRS filing Copy A.", true);
    text("Missing — complete before filing: payer TIN, payer mailing address, recipient TIN/address.");
    text("Blank withholding, state, tips and other boxes are unresolved, not confirmed zero.");
    text("Payer/recipient legal names and eligibility must be checked against the owner's records.");
    text(`Year-specific general threshold: USD ${review.threshold}; confirmed paid: USD ${candidate.confirmedTotal}.`);
    if (parseMoney(candidate.confirmedTotal) < parseMoney(review.threshold))
      text("Below the general threshold — owner must review applicability and exceptions.");
    missing.forEach(m => text(m));
    text(`Official layout: https://www.irs.gov/pub/irs-prior/f1099nec--${review.year}.pdf`);
    newPage("1099-NEC payment reconciliation — review required");
    metadata();
    text(`Recipient: ${candidate.vendor}`);
    text(`Source snapshot: ${review.sourceDigest}`);
    for (const p of candidate.payments) {
      text(`${p.date} ${p.amount} USD — ${p.confirmed ? "OWNER CONFIRMED INCLUDED" : "NOT INCLUDED"}`, true);
      text(`Payment ${p.id} | Entry ${p.entryId}`);
      text(`Category: ${p.accountName}`);
      p.warnings.forEach(w => text(w));
    }
  } else if (input.kind === "schedule-c") {
    newPage("Schedule C worksheet — book figures, not a tax return");
    metadata();
    text("Reference lines require verification against the selected year's final Schedule C.");
    text("No deduction limits, depreciation, COGS/tax adjustments or business-use allocations calculated.");
    const revenue = review.accounts.filter(a => a.type === "revenue");
    const expenses = review.accounts.filter(a => a.type === "expense");
    text("RECORDED INCOME (ledger accounting basis; not assumed cash-basis taxable income)", true);
    revenue.forEach(a => text(`${a.code} ${a.name}: ${a.amount} ${review.currency}`));
    text(`Recorded income total: ${formatMoney(revenue.reduce((s,a) => s + parseMoney(a.amount), 0n))} ${review.currency}`, true);
    text("RECORDED EXPENSES BY OWNER-REVIEWED LINE", true);
    const grouped = new Map<string, bigint>();
    for (const a of expenses) {
      const line = input.mappings?.find(m => m.accountId === a.id)?.line ?? "unmapped";
      grouped.set(line, (grouped.get(line) ?? 0n) + parseMoney(a.amount));
      text(`${line === "unmapped" ? "UNMAPPED — review required" : `Line ${line}: ${SCHEDULE_LINES[line]}`} | ${a.code} ${a.name}: ${a.amount}`);
    }
    for (const [line, amount] of grouped) text(`${line}: recorded subtotal ${formatMoney(amount)} ${review.currency}`, true);
    text("Blank/missing: business classification, tax identity, address, accounting-basis reconciliation and any non-ledger adjustments.");
    text("Meals are full recorded amounts, not a calculated allowable deduction. Unmapped accounts are included above.");
    sources([...revenue, ...expenses]);
  } else if (input.kind === "sales-tax") {
    newPage("Recorded sales / sales-tax movements worksheet");
    metadata();
    const revenue = review.accounts.filter(a => input.salesAccountIds?.includes(a.id));
    const taxes = review.accounts.filter(a => input.salesTaxAccountIds?.includes(a.id));
    text("NOT TAX OWED. No rates, nexus, exemptions, taxability or jurisdiction inferred.", true);
    if (!revenue.length || !taxes.length)
      text("INSUFFICIENT RECORDED DATA — select recorded revenue and tax-liability accounts; missing is not zero.", true);
    for (const a of [...revenue, ...taxes]) {
      text(`${a.code} ${a.name}`, true);
      text(`Recorded credit movements ${a.credits}; debit movements ${a.debits}; net ${a.amount} ${review.currency}.`);
    }
    if (revenue.length && taxes.length) {
      text(`Selected revenue credit total: ${formatMoney(revenue.reduce((s,a) => s + parseMoney(a.credits), 0n))}`, true);
      text(`Selected revenue debit total: ${formatMoney(revenue.reduce((s,a) => s + parseMoney(a.debits), 0n))}`);
      text("Debit movements are not automatically classified as refunds. Tax-account movements may include remittances or adjustments.");
    }
    text("Missing — complete before filing: jurisdiction, recorded sales-tax attribution and applicability.");
    sources([...revenue, ...taxes]);
  } else throw new HttpError(400, "Unsupported draft document.");
  newPage("Completion checklist — owner verification required");
  metadata();
  review.warnings.forEach(w => text(w));
  text(TAX_DISCLAIMER, true);
  text("Compare every figure with real ledger records and official tax-year instructions before trusting this document.");
  return pdf.save();
}
