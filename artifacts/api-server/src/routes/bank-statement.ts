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
import { and, eq } from "drizzle-orm";
import { db, bankTransactionsTable, accountsTable } from "@workspace/db";
import {
  ExtractBankStatementParams,
  ExtractBankStatementBody,
  ExtractBankStatementResponse,
  ConfirmBankStatementParams,
  ConfirmBankStatementBody,
  ConfirmBankStatementResponse,
} from "@workspace/api-zod";
import { requirePermission, formatMoney, normalBalanceFor } from "@workspace/ledger";
import { sendLedgerError, HttpError } from "../lib/errors";
import { parseMoney } from "../lib/money";
import { getSessionUserId } from "../middlewares/auth";
import { makeDedupKey } from "./bank";
import {
  statementExtractor,
  reconcileStatement,
  detectInternalTransfers,
  checkRunningBalances,
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

    if (raw.accounts.length === 0) {
      throw new HttpError(
        400,
        "This doesn't look like a bank statement — no accounts were found in the document.",
      );
    }

    // Re-parse EVERY money value through the strict decimal parser — the
    // model's strings are untrusted and a float never touches this path.
    // Zero-amount rows are dropped defensively (informational lines the
    // prompt tells the model to skip; the ledger rejects amount-less lines).
    const parsedAccounts = raw.accounts.map((acct) => {
      const openingMinor = parseMoney(acct.opening_balance, "opening balance");
      const closingMinor = parseMoney(acct.closing_balance, "closing balance");
      const txns = acct.transactions.flatMap((t) => {
        const magnitude = parseMoney(t.amount, "transaction amount");
        if (magnitude < 0n) {
          throw new HttpError(400, "Transaction amounts must be magnitudes.");
        }
        if (magnitude === 0n) return []; // informational / no-amount row
        return [
          {
            date: t.date,
            description: t.description,
            signedMinor: t.direction === "out" ? -magnitude : magnitude,
            runningMinor:
              t.running_balance == null
                ? null
                : parseMoney(t.running_balance, "running balance"),
            lowConfidence: t.low_confidence,
          },
        ];
      });
      return {
        accountName: acct.account_name,
        accountNumberLast4: acct.account_number_last4,
        openingMinor,
        closingMinor,
        transactions: txns,
      };
    });

    // Cross-account internal-transfer detection (flag only, never auto-post).
    const transferGroups = detectInternalTransfers(parsedAccounts);

    let sumOfClosings = 0n;
    const accounts = parsedAccounts.map((acct, ai) => {
      const { computedClosingMinor, discrepancyMinor, balanced } =
        reconcileStatement(
          acct.openingMinor,
          acct.closingMinor,
          acct.transactions.map((t) => t.signedMinor),
        );
      const chainFlags = checkRunningBalances(acct.openingMinor, acct.transactions);
      sumOfClosings += acct.closingMinor;
      return {
        accountName: acct.accountName,
        accountNumberLast4: acct.accountNumberLast4,
        openingBalance: formatMoney(acct.openingMinor),
        closingBalance: formatMoney(acct.closingMinor),
        computedClosingBalance: formatMoney(computedClosingMinor),
        balanced,
        discrepancy: formatMoney(discrepancyMinor),
        transactions: acct.transactions.map((t, ti) => ({
          date: t.date,
          description: t.description,
          amount: formatMoney(t.signedMinor),
          lowConfidence: t.lowConfidence,
          chainBreak: chainFlags[ti],
          transferGroup: transferGroups.get(`${ai}:${ti}`) ?? null,
        })),
      };
    });

    // Statement-level catch-all: if an entire account were missed, the
    // per-account checks would all pass while this one fails.
    const statedTotalMinor =
      raw.statement_total_ending_balance == null
        ? null
        : parseMoney(raw.statement_total_ending_balance, "total ending balance");

    res.json(
      ExtractBankStatementResponse.parse({
        periodStart: raw.period_start,
        periodEnd: raw.period_end,
        accounts,
        statementTotalEndingBalance:
          statedTotalMinor == null ? null : formatMoney(statedTotalMinor),
        sumOfClosingBalances: formatMoney(sumOfClosings),
        totalMatches:
          statedTotalMinor == null ? null : statedTotalMinor === sumOfClosings,
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

    if (body.accounts.length === 0) {
      throw new HttpError(400, "No accounts to import.");
    }
    const totalRows = body.accounts.reduce(
      (n, a) => n + a.transactions.length,
      0,
    );
    if (totalRows === 0) {
      throw new HttpError(400, "No transactions to import.");
    }
    if (totalRows > MAX_CONFIRM_ROWS) {
      throw new HttpError(400, "Too many transactions in one statement.");
    }

    // Resolve/create the ledger CASH account for every statement account
    // BEFORE inserting anything, all in one transaction.
    const result = await db.transaction(async (tx) => {
      const rows: {
        orgId: string;
        txnDate: string;
        amount: bigint;
        description: string;
        dedupKey: string;
        cashAccountId: string;
      }[] = [];

      for (const acct of body.accounts) {
        const accountName = acct.accountName.trim();
        if (!accountName) {
          throw new HttpError(400, "Each account needs a name.");
        }

        // Extraction-fidelity invariant, enforced server-side: the reviewed
        // opening balance plus EVERY row (including excluded ones) must equal
        // the reviewed closing balance. Excluded rows are review decisions,
        // not corrections — a mismatch means the rows don't match the
        // statement and must be fixed before importing.
        const openingMinor = parseMoney(acct.openingBalance, "opening balance");
        const closingMinor = parseMoney(acct.closingBalance, "closing balance");
        let sumAll = 0n;
        for (const t of acct.transactions) {
          sumAll += parseMoney(t.amount, "transaction amount");
        }
        if (openingMinor + sumAll !== closingMinor) {
          throw new HttpError(
            400,
            `"${accountName}" doesn't balance: opening ${formatMoney(openingMinor)} plus all rows is ${formatMoney(openingMinor + sumAll)}, but the closing balance is ${formatMoney(closingMinor)}. Fix the rows (or balances) before importing.`,
          );
        }

        if (acct.cashAccountId && acct.newAccount) {
          throw new HttpError(
            400,
            "Choose an existing cash account OR create a new one — not both.",
          );
        }

        let cashAccountId: string;
        if (acct.cashAccountId) {
          const [existing] = await tx
            .select({ id: accountsTable.id, type: accountsTable.type })
            .from(accountsTable)
            .where(
              and(
                eq(accountsTable.orgId, orgId),
                eq(accountsTable.id, acct.cashAccountId),
              ),
            )
            .limit(1);
          if (!existing) {
            throw new HttpError(400, `No such account for "${accountName}".`);
          }
          if (existing.type !== "asset") {
            throw new HttpError(
              400,
              `The cash account for "${accountName}" must be an asset account.`,
            );
          }
          cashAccountId = existing.id;
        } else if (acct.newAccount) {
          // Creating chart-of-accounts records is an administrative action —
          // ledger.post (staff) is not enough.
          await requirePermission(orgId, userId, "coa.manage");
          const code = acct.newAccount.code.trim();
          const name = acct.newAccount.name.trim();
          if (!/^\d{3,10}$/.test(code)) {
            throw new HttpError(
              400,
              `New account code for "${accountName}" must be 3-10 digits.`,
            );
          }
          if (!name) {
            throw new HttpError(
              400,
              `New account for "${accountName}" needs a name.`,
            );
          }
          const [clash] = await tx
            .select({ id: accountsTable.id })
            .from(accountsTable)
            .where(
              and(eq(accountsTable.orgId, orgId), eq(accountsTable.code, code)),
            )
            .limit(1);
          if (clash) {
            throw new HttpError(
              400,
              `Account code ${code} already exists — pick it from the list instead.`,
            );
          }
          const [created] = await tx
            .insert(accountsTable)
            .values({
              orgId,
              code,
              name,
              type: "asset",
              normalBalance: normalBalanceFor("asset"),
            })
            .returning({ id: accountsTable.id });
          cashAccountId = created.id;
        } else {
          throw new HttpError(
            400,
            `Map "${accountName}" to a cash account before importing.`,
          );
        }

        // Account identity in the dedup key: identical transactions in two
        // sibling accounts are distinct rows, while re-uploading the same
        // statement still collapses to no-ops.
        const acctKey = `${accountName} ${acct.accountNumberLast4 ?? ""}`
          .trim()
          .toUpperCase()
          .replace(/\s+/g, " ");

        for (const t of acct.transactions) {
          if (t.excluded) continue; // reviewed out (e.g. transfer legs)
          if (!DATE_RE.test(t.date)) {
            throw new HttpError(400, "Each transaction needs a YYYY-MM-DD date.");
          }
          const description = t.description.trim();
          if (!description) {
            throw new HttpError(400, "Each transaction needs a description.");
          }
          const amount = parseMoney(t.amount, "transaction amount");
          if (amount === 0n) {
            throw new HttpError(
              400,
              "Zero-amount transactions cannot be imported.",
            );
          }
          rows.push({
            orgId,
            txnDate: t.date,
            amount,
            description,
            dedupKey: `${acctKey}|${makeDedupKey(t.date, amount, description)}`,
            cashAccountId,
          });
        }
      }

      if (rows.length === 0) {
        throw new HttpError(
          400,
          "Every transaction is excluded — nothing to import.",
        );
      }

      // Same idempotency mechanism as Plaid sync: unique (orgId, dedupKey)
      // with onConflictDoNothing collapses re-uploads of the same statement.
      const inserted = await tx
        .insert(bankTransactionsTable)
        .values(rows)
        .onConflictDoNothing({
          target: [bankTransactionsTable.orgId, bankTransactionsTable.dedupKey],
        })
        .returning({ id: bankTransactionsTable.id });
      return { inserted: inserted.length, total: rows.length };
    });

    res.json(
      ConfirmBankStatementResponse.parse({
        inserted: result.inserted,
        skippedDuplicates: result.total - result.inserted,
      }),
    );
  } catch (err) {
    sendLedgerError(res, err);
  }
});

export default router;
