/**
 * PDF → grid extraction for the import preview endpoint.
 *
 * A QuickBooks "Trial Balance" PDF is a positioned-text table: every text run
 * carries an (x, y) transform. We reconstruct the grid COLUMN-AWARE:
 *
 *  1. Group text items into visual lines by their y position (with a small
 *     tolerance for baseline jitter).
 *  2. Find the header line — the one containing both "debit" and "credit" —
 *     and record each column's x center.
 *  3. For every other line, assign each text run to the nearest header column
 *     (by horizontal center); runs left of the first amount column are the
 *     account name. Cells are ordered to match the header's column order.
 *
 * The result feeds the SAME `parseQboTrialBalance` grid parser the CSV/XLSX
 * paths use — this file only reshapes text, it never touches money math
 * (amounts stay verbatim strings for `parseDecimalToMinor` downstream).
 */

export interface PositionedText {
  str: string;
  x: number;
  y: number;
  width: number;
}

interface Line {
  y: number;
  items: PositionedText[];
}

const Y_TOLERANCE = 2.5;

/** Group positioned runs into visual lines (top-to-bottom, left-to-right). */
export function groupIntoLines(items: PositionedText[]): Line[] {
  const lines: Line[] = [];
  // Sort by y descending (PDF y grows upward), then x.
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  for (const item of sorted) {
    if (!item.str.trim()) continue;
    const line = lines.find((l) => Math.abs(l.y - item.y) <= Y_TOLERANCE);
    if (line) {
      line.items.push(item);
      // Keep a running representative y so tolerance is relative to the line.
      line.y = (line.y * (line.items.length - 1) + item.y) / line.items.length;
    } else {
      lines.push({ y: item.y, items: [item] });
    }
  }
  for (const line of lines) line.items.sort((a, b) => a.x - b.x);
  return lines;
}

/** Merge adjacent runs on one line into cells when the gap between them is small. */
function lineToCells(line: Line): { text: string; x: number; width: number }[] {
  const GAP = 6; // points; runs closer than this are the same cell
  const cells: { text: string; x: number; width: number }[] = [];
  for (const item of line.items) {
    const last = cells[cells.length - 1];
    if (last && item.x - (last.x + last.width) <= GAP) {
      last.text += item.str;
      last.width = item.x + item.width - last.x;
    } else {
      cells.push({ text: item.str, x: item.x, width: item.width });
    }
  }
  for (const c of cells) c.text = c.text.trim();
  return cells.filter((c) => c.text.length > 0);
}

const center = (c: { x: number; width: number }) => c.x + c.width / 2;

/** Friendly error for oversized / hostile PDFs — surfaced as a 400 upstream. */
export class PdfTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfTooLargeError";
  }
}

// Hard caps so a hostile PDF cannot soak CPU/memory. A real Trial Balance
// report is a few pages and a few thousand text runs.
const MAX_PDF_BYTES = 5 * 1024 * 1024;
const MAX_PDF_PAGES = 50;
const MAX_TEXT_ITEMS = 100_000;

/** True when a cell line is a (possibly repeated, per-page) column header. */
function isHeaderLine(cells: { text: string }[]): boolean {
  const texts = cells.map((c) => c.text.trim().toLowerCase());
  const has = (label: string) => texts.some((t) => t === label || t.startsWith(`${label} `));
  return has("debit") && has("credit");
}

/**
 * Reconstruct a string grid from positioned text. Returns rows shaped for
 * `parseQboTrialBalance`: preamble lines as single-cell rows, then a header
 * row, then [account, debit, credit] data rows aligned to header columns.
 */
export function itemsToGrid(items: PositionedText[]): string[][] {
  const lines = groupIntoLines(items);
  const cellLines = lines.map(lineToCells).filter((cells) => cells.length > 0);

  // Locate the FIRST header line: contains both DEBIT and CREDIT cells.
  // (Multi-page reports repeat the header on every page — later occurrences
  // are skipped in the data loop below.)
  const headerIdx = cellLines.findIndex(isHeaderLine);

  if (headerIdx === -1) {
    // No recognizable table — return every line as a single joined cell so the
    // grid parser produces its friendly "couldn't find columns" error.
    return cellLines.map((cells) => [cells.map((c) => c.text).join(" ")]);
  }

  const headerCells = cellLines[headerIdx];
  const findCol = (label: string) =>
    headerCells.find((c) => {
      const t = c.text.trim().toLowerCase();
      return t === label || t.startsWith(`${label} `);
    })!;
  const debitCell = findCol("debit");
  const creditCell = findCol("credit");
  const firstAmountX = Math.min(debitCell.x, creditCell.x);

  const grid: string[][] = [];

  // Preamble (company name, "As of ..." etc.) — single-cell rows.
  for (let i = 0; i < headerIdx; i++) {
    grid.push([cellLines[i].map((c) => c.text).join(" ")]);
  }

  grid.push(["Account", "Debit", "Credit"]);

  for (let i = headerIdx + 1; i < cellLines.length; i++) {
    const cells = cellLines[i];
    // Multi-page reports repeat the column header on every page — skip them.
    if (isHeaderLine(cells)) continue;
    let name = "";
    let debit = "";
    let credit = "";
    for (const cell of cells) {
      // POSITIONAL assignment only: everything that ends left of the amount
      // columns is account text, regardless of its characters — a name like
      // "401(k) Plan" or a purely numeric account code must never be mistaken
      // for money. QBO left-aligns names, right-aligns amounts.
      if (cell.x + cell.width < firstAmountX - 4) {
        name = name ? `${name} ${cell.text}` : cell.text;
        continue;
      }
      // Assign to the nearer of the two amount columns by center distance.
      const cx = center(cell);
      const dDebit = Math.abs(cx - center(debitCell));
      const dCredit = Math.abs(cx - center(creditCell));
      if (dDebit <= dCredit) {
        debit = debit ? `${debit}${cell.text}` : cell.text;
      } else {
        credit = credit ? `${credit}${cell.text}` : cell.text;
      }
    }
    // Strip currency symbols/whitespace and normalize accounting-style
    // parenthesized negatives "(1,234.00)" → "-1,234.00". Pure text reshaping —
    // the value string itself is parsed downstream by parseDecimalToMinor.
    const clean = (s: string) => {
      let t = s.replace(/[$\s]/g, "");
      const m = t.match(/^\((.+)\)$/);
      if (m) t = `-${m[1]}`;
      return t;
    };
    grid.push([name, clean(debit), clean(credit)]);
  }

  return grid;
}

/** Extract positioned text from every page of a PDF buffer. */
export async function pdfToRows(data: Uint8Array): Promise<string[][]> {
  if (data.byteLength > MAX_PDF_BYTES) {
    throw new PdfTooLargeError(
      "This PDF is too large. Please upload the Trial Balance report itself (under 5 MB).",
    );
  }
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await getDocument({
    data,
    useSystemFonts: true,
  }).promise;
  try {
    if (doc.numPages > MAX_PDF_PAGES) {
      throw new PdfTooLargeError(
        "This PDF has too many pages to be a Trial Balance report. Please upload the report itself.",
      );
    }
    const items: PositionedText[] = [];
    let yOffset = 0;
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      let pageMinY = Infinity;
      const pageItems: PositionedText[] = [];
      for (const it of content.items) {
        if (!("str" in it)) continue;
        const [, , , , x, y] = it.transform as number[];
        pageItems.push({ str: it.str, x, y: y + yOffset, width: it.width });
        if (y < pageMinY) pageMinY = y;
      }
      items.push(...pageItems);
      if (items.length > MAX_TEXT_ITEMS) {
        throw new PdfTooLargeError(
          "This PDF contains too much text to be a Trial Balance report.",
        );
      }
      // Stack subsequent pages below: shift the offset past this page's lowest line.
      const pageHeight = page.view[3] - page.view[1];
      yOffset -= pageHeight;
      page.cleanup();
    }
    return itemsToGrid(items);
  } finally {
    await doc.cleanup();
  }
}
