import type { Money } from "./money";

/**
 * First-class tabular export for reports and registers. Pure functions with no
 * DB access: callers build a Sheet/Workbook from any report and serialize it to
 * CSV (RFC-4180) or a SpreadsheetML XML workbook that Excel opens natively.
 *
 * Money is integer minor units (BigInt) everywhere in the ledger; it is only
 * turned into a human decimal string at the export boundary via formatMoney, so
 * no float ever touches a monetary value.
 */

export type Cell = string | number | bigint | null | undefined;

export interface Sheet {
  name: string;
  columns: string[];
  rows: Cell[][];
}

export interface Workbook {
  sheets: Sheet[];
}

/** Format integer minor units as a fixed 2-decimal string (e.g. 12345n -> "123.45"). */
export function formatMoney(v: Money): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const s = abs.toString().padStart(3, "0");
  return `${neg ? "-" : ""}${s.slice(0, -2)}.${s.slice(-2)}`;
}

function cellToText(cell: Cell): string {
  if (cell === null || cell === undefined) return "";
  if (typeof cell === "bigint") return cell.toString();
  return String(cell);
}

/** True when a CSV field must be quoted per RFC-4180. */
function needsQuoting(field: string): boolean {
  return (
    field.includes(",") ||
    field.includes('"') ||
    field.includes("\n") ||
    field.includes("\r")
  );
}

function csvField(field: string): string {
  if (!needsQuoting(field)) return field;
  return `"${field.replace(/"/g, '""')}"`;
}

/** Serialize a single sheet to an RFC-4180 CSV string (CRLF line endings). */
export function toCsv(sheet: Sheet): string {
  const lines: string[] = [];
  lines.push(sheet.columns.map(csvField).join(","));
  for (const row of sheet.rows) {
    lines.push(row.map((c) => csvField(cellToText(c))).join(","));
  }
  return lines.join("\r\n");
}

/** One CSV file per sheet (CSV is single-sheet); safe filenames derived from names. */
export function workbookToCsvFiles(
  workbook: Workbook,
): Array<{ name: string; content: string }> {
  return workbook.sheets.map((sheet) => ({
    name: `${safeFileName(sheet.name)}.csv`,
    content: toCsv(sheet),
  }));
}

function safeFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "sheet";
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isNumericCell(cell: Cell): boolean {
  if (typeof cell === "number") return Number.isFinite(cell);
  if (typeof cell === "bigint") return true;
  return false;
}

/**
 * Serialize a workbook to SpreadsheetML 2003 XML — a real multi-sheet Excel
 * format that Excel and LibreOffice open natively, with no external dependency.
 * Numeric cells are typed as Number so Excel treats them as values, not text.
 */
export function toSpreadsheetXml(workbook: Workbook): string {
  const parts: string[] = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>');
  parts.push('<?mso-application progid="Excel.Sheet"?>');
  parts.push(
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" ' +
      'xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">',
  );

  for (const sheet of workbook.sheets) {
    parts.push(`<Worksheet ss:Name="${xmlEscape(sheet.name)}">`);
    parts.push("<Table>");

    parts.push("<Row>");
    for (const col of sheet.columns) {
      parts.push(
        `<Cell><Data ss:Type="String">${xmlEscape(col)}</Data></Cell>`,
      );
    }
    parts.push("</Row>");

    for (const row of sheet.rows) {
      parts.push("<Row>");
      for (const cell of row) {
        if (isNumericCell(cell)) {
          parts.push(
            `<Cell><Data ss:Type="Number">${cellToText(cell)}</Data></Cell>`,
          );
        } else {
          parts.push(
            `<Cell><Data ss:Type="String">${xmlEscape(cellToText(cell))}</Data></Cell>`,
          );
        }
      }
      parts.push("</Row>");
    }

    parts.push("</Table>");
    parts.push("</Worksheet>");
  }

  parts.push("</Workbook>");
  return parts.join("\n");
}

export type ExportFormat = "csv" | "excel";

export interface ExportFile {
  name: string;
  contentType: string;
  content: string;
}

/**
 * Serialize a workbook to concrete downloadable files in the chosen format:
 * one CSV per sheet, or a single multi-sheet Excel (SpreadsheetML) file.
 */
export function serializeWorkbook(
  workbook: Workbook,
  format: ExportFormat,
  baseName = "export",
): ExportFile[] {
  if (format === "csv") {
    return workbookToCsvFiles(workbook).map((f) => ({
      name: f.name,
      contentType: "text/csv",
      content: f.content,
    }));
  }
  return [
    {
      name: `${safeFileName(baseName)}.xls`,
      contentType: "application/vnd.ms-excel",
      content: toSpreadsheetXml(workbook),
    },
  ];
}
