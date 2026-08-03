/**
 * "Import Bank Statement (PDF)" — a second ingestion source for raw bank
 * transactions alongside Plaid sync.
 *
 * Two-step, human-in-the-loop:
 *   1. POST /bank/statement/extract  — DRY RUN. PDF (base64, memory-only) →
 *      vision-LLM extraction → Zod-validated, money re-parsed to BigInt,
 *      balance-reconciled server-side. Nothing is stored.
 *   2. POST /bank/statement/confirm  — inserts the USER-REVIEWED rows as
 *      uncategorized bank_transactions using the same content dedup key as
 *      Plaid sync (`date|minorAmount|normalizedName` + onConflictDoNothing),
 *      so re-uploading the same statement is a no-op. Posting to the ledger
 *      still happens only through the existing reconcile/categorize flow.
 *
 * Security: never written to disk, never logged, magic-byte + size + page
 * caps before any parsing, generic errors, heavy rate limiter (see routes
 * index). Model output is data, never executed.
 */
import { createHash } from "node:crypto";
import { Router, type IRouter } from "express";
import { db, bankTransactionsTable } from "@workspace/db";
import {
  ExtractBankStatementParams,
  ExtractBankStatementBody,
  ExtractBankStatementResponse,
  ConfirmBankStatementParams,
  ConfirmBankStatementBody,
  ConfirmBankStatementResponse,
} from "@workspace/api-zod";
import { requirePermission, formatMoney } from "@workspace/ledger";
import { sendLedgerError, HttpError } from "../lib/errors";
import { parseMoney } from "../lib/money";
import { getSessionUserId } from "../middlewares/auth";
import { makeDedupKey } from "./bank";
import {
  statementExtractor,
  reconcileStatement,
} from "../lib/statement-extraction";

const router: IRouter = Router();

const MAX_STATEMENT_BYTES = 10 * 1024 * 1024;
const MAX_STATEMENT_PAGES = 60;

const BAD_FILE = new HttpError(
  400,
  "We couldn't read this file. Please upload the PDF statement you downloaded from your bank (under 10 MB).",
);

/** Validate the upload is a real, reasonably-sized PDF before anything else. */
async function validatePdf(buf: Buffer): Promise<void> {
  if (buf.byteLength > MAX_STATEMENT_BYTES) throw BAD_FILE;
  // %PDF- magic bytes — reject non-PDF uploads outright.
  if (buf.byteLength < 5 || buf.toString("latin1", 0, 5) !== "%PDF-") {
    throw BAD_FILE;
  }
  // Page-count cap: parse the structure only (defensive — pdfjs handles
  // malformed files by throwing, which we map to a friendly 400).
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  let doc;
  try {
    doc = await getDocument({ data: new Uint8Array(buf) }).promise;
  } catch {
    throw BAD_FILE;
  }
  try {
    if (doc.numPages > MAX_STATEMENT_PAGES) {
      throw new HttpError(
        400,
        "This PDF has too many pages to be a bank statement. Please upload a single statement.",
      );
    }
  } finally {
    await doc.cleanup();
  }
}

router.post("/orgs/:orgId/bank/statement/extract", async (req, res) => {
  try {
    const userId = getSessionUserId(req);
    const { orgId } = ExtractBankStatementParams.parse(req.params);
    const body = ExtractBankStatementBody.parse(req.body);
    await requirePermission(orgId, userId, "ledger.post");

    const buf = Buffer.from(body.content, "base64");
    await validatePdf(buf);

    let raw;
    try {
      raw = await statementExtractor.extract(buf.toString("base64"));
    } catch (err) {
      req.log?.warn({ msg: "statement extraction failed" });
      throw new HttpError(
        400,
        "We couldn't extract transactions from this statement. Please try again, or use a clearer copy.",
      );
    }

    // Re-parse EVERY money value through the strict decimal parser — the
    // model's strings are untrusted and a float never touches this path.
    const openingMinor = parseMoney(raw.opening_balance, "opening balance");
    const closingMinor = parseMoney(raw.closing_balance, "closing balance");
    const txns = raw.transactions.map((t) => {
      const magnitude = parseMoney(t.amount, "transaction amount");
      if (magnitude < 0n) {
        throw new HttpError(400, "Transaction amounts must be magnitudes.");
      }
      const signed = t.direction === "out" ? -magnitude : magnitude;
      return {
        date: t.date,
        description: t.description,
        signed,
        lowConfidence: t.low_confidence,
      };
    });

    const { computedClosingMinor, discrepancyMinor, balanced } =
      reconcileStatement(openingMinor, closingMinor, txns.map((t) => t.signed));

    res.json(
      ExtractBankStatementResponse.parse({
        periodStart: raw.period_start,
        periodEnd: raw.period_end,
        openingBalance: formatMoney(openingMinor),
        closingBalance: formatMoney(closingMinor),
        computedClosingBalance: formatMoney(computedClosingMinor),
        balanced,
        discrepancy: formatMoney(discrepancyMinor),
        transactions: txns.map((t) => ({
          date: t.date,
          description: t.description,
          amount: formatMoney(t.signed),
          lowConfidence: t.lowConfidence,
        })),
        statementHash: createHash("sha256").update(buf).digest("hex"),
      }),
    );
  } catch (err) {
    sendLedgerError(res, err);
  }
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_CONFIRM_ROWS = 3000;

router.post("/orgs/:orgId/bank/statement/confirm", async (req, res) => {
  try {
    const userId = getSessionUserId(req);
    const { orgId } = ConfirmBankStatementParams.parse(req.params);
    const body = ConfirmBankStatementBody.parse(req.body);
    await requirePermission(orgId, userId, "ledger.post");

    if (body.transactions.length === 0) {
      throw new HttpError(400, "No transactions to import.");
    }
    if (body.transactions.length > MAX_CONFIRM_ROWS) {
      throw new HttpError(400, "Too many transactions in one statement.");
    }

    const rows = body.transactions.map((t) => {
      if (!DATE_RE.test(t.date)) {
        throw new HttpError(400, "Each transaction needs a YYYY-MM-DD date.");
      }
      const description = t.description.trim();
      if (!description) {
        throw new HttpError(400, "Each transaction needs a description.");
      }
      const amount = parseMoney(t.amount, "transaction amount");
      if (amount === 0n) {
        throw new HttpError(400, "Zero-amount transactions cannot be imported.");
      }
      return {
        orgId,
        txnDate: t.date,
        amount,
        description,
        dedupKey: makeDedupKey(t.date, amount, description),
      };
    });

    // Same idempotency mechanism as Plaid sync: unique (orgId, dedupKey) with
    // onConflictDoNothing collapses re-uploads of the same statement.
    const inserted = await db
      .insert(bankTransactionsTable)
      .values(rows)
      .onConflictDoNothing({
        target: [bankTransactionsTable.orgId, bankTransactionsTable.dedupKey],
      })
      .returning({ id: bankTransactionsTable.id });

    res.json(
      ConfirmBankStatementResponse.parse({
        inserted: inserted.length,
        skippedDuplicates: rows.length - inserted.length,
      }),
    );
  } catch (err) {
    sendLedgerError(res, err);
  }
});

export default router;
