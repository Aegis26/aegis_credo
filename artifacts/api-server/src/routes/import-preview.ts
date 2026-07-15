import { Router, type IRouter } from "express";
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import {
  PreviewImportParams,
  PreviewImportBody,
  PreviewImportResponse,
} from "@workspace/api-zod";
import {
  requirePermission,
  csvToRows,
  parseQboTrialBalance,
  toImportFileInput,
  TrialBalanceParseError,
} from "@workspace/ledger";
import { sendLedgerError, HttpError } from "../lib/errors";
import { getSessionUserId } from "../middlewares/auth";

const router: IRouter = Router();

/**
 * DEV ONLY: persist a copy of every uploaded import file so a real-world
 * export can be promoted to a regression-test fixture verbatim. Runs only in
 * development (not production, not tests); never fails the request.
 */
function captureUploadForFixture(contentType: "csv" | "xlsx", content: string): void {
  if (process.env.NODE_ENV !== "development") return;
  if (content.length > 5 * 1024 * 1024) return; // cap capture at ~5MB
  try {
    const dir = path.resolve(process.cwd(), "import-uploads");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(dir, `upload-${stamp}.${contentType}`);
    if (contentType === "csv") {
      fs.writeFileSync(file, content, "utf8");
    } else {
      fs.writeFileSync(file, Buffer.from(content, "base64"));
    }
  } catch {
    // Best-effort capture only — never block the preview.
  }
}

/**
 * Render an ExcelJS cell value to a plain string. Numeric cells are serialized
 * with `String()` — a lossless shortest round-trip of the stored value — NOT
 * arithmetic like `* 100` or `toFixed`, so no float rounding is introduced on
 * the money path. The resulting decimal string is parsed to integer minor units
 * downstream by `parseDecimalToMinor`; any value with more than two fraction
 * digits (i.e. float noise) is rejected there with a friendly error.
 */
function cellToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    if ("result" in value && value.result !== undefined) {
      return cellToString(value.result as ExcelJS.CellValue);
    }
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((t) => t.text).join("");
    }
    if ("text" in value && typeof value.text === "string") return value.text;
  }
  return "";
}

/** Parse an XLSX buffer into a grid of string cells. */
async function xlsxToRows(data: ArrayBuffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const rows: string[][] = [];
  ws.eachRow({ includeEmpty: true }, (row) => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell) => {
      cells.push(cellToString(cell.value));
    });
    rows.push(cells);
  });
  return rows;
}

/**
 * Dry-run adapter endpoint. Translates a raw vendor export (QBO Trial Balance
 * CSV/XLSX) into the canonical import draft WITHOUT posting anything. The client
 * confirms account types in the Review step, then posts the returned draft to
 * the existing, frozen POST /orgs/:orgId/import. This route never touches the
 * ledger — a broken adapter can only fail to produce a draft.
 */
router.post("/orgs/:orgId/import/preview", async (req, res) => {
  try {
    const userId = getSessionUserId(req);
    const { orgId } = PreviewImportParams.parse(req.params);
    const body = PreviewImportBody.parse(req.body);
    await requirePermission(orgId, userId, "ledger.post");

    captureUploadForFixture(body.contentType, body.content);

    let rows: string[][];
    try {
      if (body.contentType === "csv") {
        rows = csvToRows(body.content);
      } else {
        const buf = Buffer.from(body.content, "base64");
        const ab = buf.buffer.slice(
          buf.byteOffset,
          buf.byteOffset + buf.byteLength,
        );
        rows = await xlsxToRows(ab);
      }
    } catch {
      throw new HttpError(
        400,
        "We couldn't read this file. Please upload the CSV or Excel you exported from Reports > Trial Balance.",
      );
    }

    // report is currently always qbo_trial_balance (the only registered adapter).
    const parse = parseQboTrialBalance(rows);
    const draft = toImportFileInput(parse);

    res.json(
      PreviewImportResponse.parse({
        source: "quickbooks",
        companyName: parse.companyName,
        asOf: parse.asOf,
        accounts: parse.accounts,
        totalDebit: parse.totalDebit,
        totalCredit: parse.totalCredit,
        balanced: parse.balanced,
        ambiguousCount: parse.accounts.filter(
          (a) => a.typeSource === "ambiguous",
        ).length,
        draft,
      }),
    );
  } catch (err) {
    if (err instanceof TrialBalanceParseError) {
      res.status(400).json({ error: err.message });
      return;
    }
    sendLedgerError(res, err);
  }
});

export default router;
