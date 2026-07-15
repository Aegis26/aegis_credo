import { createHash } from "node:crypto";
import { Router, type IRouter } from "express";
import {
  ImportAccountingFileParams,
  ImportAccountingFileBody,
  ImportAccountingFileResponse,
} from "@workspace/api-zod";
import {
  requirePermission,
  importFile,
  formatMoney,
  type ImportFile,
} from "@workspace/ledger";
import { sendLedgerError } from "../lib/errors";
import { getSessionUserId } from "../middlewares/auth";

const router: IRouter = Router();

/**
 * Deterministic content hash of the uploaded file. This is what makes an import
 * idempotent: the same file content always yields the same ref, so re-importing
 * posts nothing new. Keys are sorted so semantically-identical files with
 * different property order still hash the same. Computed SERVER-SIDE — a client
 * can never supply its own ref.
 */
function contentRef(body: unknown): string {
  const canonical = JSON.stringify(body, (_key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.keys(value as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = (value as Record<string, unknown>)[k];
          return acc;
        }, {});
    }
    return value;
  });
  return createHash("sha256").update(canonical).digest("hex");
}

router.post("/orgs/:orgId/import", async (req, res) => {
  try {
    const userId = getSessionUserId(req);
    const { orgId } = ImportAccountingFileParams.parse(req.params);
    const body = ImportAccountingFileBody.parse(req.body);
    await requirePermission(orgId, userId, "ledger.post");

    const file: ImportFile = {
      source: body.source,
      ref: contentRef(body),
      accounts: body.accounts,
      openingBalances: body.openingBalances,
      transactions: body.transactions,
      openInvoices: body.openInvoices,
      openBills: body.openBills,
    };

    const report = await importFile(orgId, file, {
      actor: userId,
      onExistingOpening: body.onExistingOpening ?? "block",
    });

    res.json(
      ImportAccountingFileResponse.parse({
        source: report.source,
        ref: report.ref,
        accounts: report.accounts.map((a) => ({
          code: a.code,
          name: a.name,
          sourceDebit: formatMoney(a.sourceDebit),
          sourceCredit: formatMoney(a.sourceCredit),
          ledgerDebit: formatMoney(a.ledgerDebit),
          ledgerCredit: formatMoney(a.ledgerCredit),
          matched: a.matched,
        })),
        sourceTotalDebit: formatMoney(report.sourceTotalDebit),
        sourceTotalCredit: formatMoney(report.sourceTotalCredit),
        ledgerTotalDebit: formatMoney(report.ledgerTotalDebit),
        ledgerTotalCredit: formatMoney(report.ledgerTotalCredit),
        sourceBalanced: report.sourceBalanced,
        matched: report.matched,
        entriesPosted: report.entriesPosted,
        invoicesCreated: report.invoicesCreated,
        billsCreated: report.billsCreated,
      }),
    );
  } catch (err) {
    sendLedgerError(res, err);
  }
});

export default router;
