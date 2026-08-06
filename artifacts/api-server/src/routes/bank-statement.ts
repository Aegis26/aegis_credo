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
  StatementExtractionError,
} from "../lib/statement-extraction";

const router: IRouter = Router();

const MAX_STATEMENT_BYTES = 10 * 1024 * 1024;
const MAX_STATEMENT_PAGES = 60;

/** Map a typed extraction failure to a specific, actionable user message. */
export function extractionErrorMessage(err: unknown): string {
  if (err instanceof StatementExtractionError) {
    switch (err.kind) {
      case "too_long":
        return "This statement is too long to read in one pass. Try uploading a shorter date range, or split the statement into parts.";
      case "rate_limited":
        return "The statement reader is busy right now. Please wait a minute and try again.";
      case "service":
        return "The statement reader is temporarily unavailable. Please try again shortly.";
      case "unreadable":
        return "We couldn't reliably read this statement. If it's a scanned copy, try a clearer scan — or upload the original digital PDF from your bank.";
    }
  }
  return "We couldn't extract transactions from this statement. Please try again, or use a clearer copy.";
}

/** Validate the upload is a real, reasonably-sized PDF before anything else. */
async function validatePdf(buf: Buffer): Promise<void> {
  if (buf.byteLength > MAX_STATEMENT_BYTES) {
    throw new HttpError(
      400,
      "This statement is over 10 MB. Please upload a smaller PDF — most bank statements are well under 10 MB.",
    );
  }
  // %PDF- magic bytes — reject non-PDF uploads outright.
  if (buf.byteLength < 5 || buf.toString("latin1", 0, 5) !== "%PDF-") {
    throw new HttpError(
      400,
      "This file doesn't look like a PDF. Please upload the PDF statement you downloaded from your bank.",
    );
  }
  // Page-count cap: parse the structure only (defensive — pdfjs handles
  // malformed files by throwing, which we map to a friendly 400).
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  let doc;
  try {
    doc = await getDocument({ data: new Uint8Array(buf) }).promise;
  } catch (err) {
    // pdfjs throws PasswordException for encrypted PDFs — tell the user
    // exactly that instead of a generic "couldn't read it".
    const name =
      err && typeof err === "object" && "name" in err
        ? String((err as { name: unknown }).name)
        : undefined;
    if (name === "PasswordException") {
      throw new HttpError(
        400,
        "This PDF is password-protected. Please remove the password (for example, open it and save/print to a new PDF) and re-upload.",
      );
    }
    throw new HttpError(
      400,
      "We couldn't open this PDF — it may be corrupted. Try downloading a fresh copy from your bank.",
    );
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
      // Diagnosability: log the error CLASS/status/stop_reason only — never
      // the PDF, the model output, or provider error message bodies.
      const meta =
        err instanceof StatementExtractionError
          ? { kind: err.kind, ...err.meta }
          : {
              errorClass:
                err instanceof Error ? err.constructor.name : typeof err,
            };
      req.log?.warn(meta, "statement extraction failed");
      throw new HttpError(400, extractionErrorMessage(err));
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
