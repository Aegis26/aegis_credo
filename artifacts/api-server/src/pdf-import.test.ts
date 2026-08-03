/**
 * PDF Trial Balance import preview — verifies the PDF text-extraction path
 * produces the SAME parse as the CSV path for the user's verbatim QuickBooks
 * fixture. The test renders the fixture into a positioned-text PDF (pdfkit,
 * left-aligned names / right-aligned amount columns like QuickBooks) and runs
 * it through the production `pdfToRows` → `parseQboTrialBalance` pipeline.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import { csvToRows, parseQboTrialBalance } from "@workspace/ledger";
import { pdfToRows, itemsToGrid, type PositionedText } from "./lib/pdf-table";

const FIXTURE = path.resolve(
  __dirname,
  "../../../lib/ledger/src/import-adapters/fixtures/craigs-trial-balance.csv",
);

/** Render the fixture CSV as a QuickBooks-style PDF table. */
function fixtureAsPdf(): Promise<Buffer> {
  const rows = csvToRows(readFileSync(FIXTURE, "utf8"));
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: "LETTER" });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const nameX = 40;
    const debitX = 330;
    const creditX = 450;
    const colW = 100;
    doc.fontSize(9);
    for (const row of rows) {
      const [name = "", debit = "", credit = ""] = row;
      if (doc.y > 720) doc.addPage();
      const y = doc.y;
      if (name) doc.text(name, nameX, y, { lineBreak: false, width: 280 });
      if (debit) doc.text(debit, debitX, y, { lineBreak: false, width: colW, align: "right" });
      if (credit) doc.text(credit, creditX, y, { lineBreak: false, width: colW, align: "right" });
      doc.text("", nameX, y + 14, { lineBreak: false });
    }
    doc.end();
  });
}

describe("PDF trial balance extraction", () => {
  it("parses the QuickBooks fixture rendered as PDF identically to the CSV path", async () => {
    const csvParse = parseQboTrialBalance(csvToRows(readFileSync(FIXTURE, "utf8")));

    const pdf = await fixtureAsPdf();
    const grid = await pdfToRows(new Uint8Array(pdf));
    const pdfParse = parseQboTrialBalance(grid);

    expect(pdfParse.accounts.map((a) => a.name)).toEqual(
      csvParse.accounts.map((a) => a.name),
    );
    expect(pdfParse.accounts.map((a) => [a.debit, a.credit])).toEqual(
      csvParse.accounts.map((a) => [a.debit, a.credit]),
    );
    expect(pdfParse.totalDebit).toBe(csvParse.totalDebit);
    expect(pdfParse.totalCredit).toBe(csvParse.totalCredit);
    expect(pdfParse.balanced).toBe(csvParse.balanced);
  }, 30000);

  it("returns a friendly grid when the PDF has no Debit/Credit header", () => {
    const items: PositionedText[] = [
      { str: "Some random document", x: 40, y: 700, width: 120 },
      { str: "with no table at all", x: 40, y: 680, width: 110 },
    ];
    const grid = itemsToGrid(items);
    expect(() => parseQboTrialBalance(grid)).toThrowError(/couldn't find/i);
  });
});
