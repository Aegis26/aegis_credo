import { Router, type IRouter } from "express";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  db,
  accountsTable,
  bankConnectionsTable,
  bankTransactionsTable,
} from "@workspace/db";
import {
  ListBankTransactionsParams,
  ListBankTransactionsQueryParams,
  ListBankTransactionsResponse,
  CategorizeBankTransactionParams,
  CategorizeBankTransactionBody,
  CategorizeBankTransactionResponse,
  GetBankStatusParams,
  GetBankStatusResponse,
  CreateBankLinkTokenParams,
  CreateBankLinkTokenResponse,
  ExchangeBankTokenParams,
  ExchangeBankTokenBody,
  ExchangeBankTokenResponse,
  SyncBankParams,
  SyncBankResponse,
} from "@workspace/api-zod";
import {
  requirePermission,
  postJournalEntry,
  formatMoney,
  NotFoundError,
} from "@workspace/ledger";
import { sendLedgerError, HttpError } from "../lib/errors";
import { getSessionUserId } from "../middlewares/auth";
import { accountByCode } from "./orgs";
import {
  isPlaidConfigured,
  createLinkToken,
  exchangePublicToken,
  getInstitutionName,
  syncTransactions,
} from "../lib/plaid";

const router: IRouter = Router();

type BankTxnRow = typeof bankTransactionsTable.$inferSelect;

function toBankTxn(txn: BankTxnRow) {
  return {
    id: txn.id,
    txnDate: txn.txnDate,
    description: txn.description,
    amount: formatMoney(txn.amount),
    matched: txn.matchedEntryId != null,
    matchedEntryId: txn.matchedEntryId,
    accountId: txn.accountId,
  };
}

/** Assemble the connection + reconciliation status for an org. */
async function bankStatus(orgId: string) {
  const [connection] = await db
    .select()
    .from(bankConnectionsTable)
    .where(eq(bankConnectionsTable.orgId, orgId))
    .limit(1);

  const [pending] = await db
    .select({ count: sql<string>`COUNT(*)` })
    .from(bankTransactionsTable)
    .where(
      and(
        eq(bankTransactionsTable.orgId, orgId),
        isNull(bankTransactionsTable.matchedEntryId),
      ),
    );

  return {
    connected: connection != null,
    institutionName: connection?.institutionName ?? null,
    lastSyncedAt: connection?.lastSyncedAt
      ? connection.lastSyncedAt.toISOString()
      : null,
    pendingCount: Number(pending?.count ?? "0"),
    lastSyncError: connection?.lastSyncError ?? null,
    configured: isPlaidConfigured(),
  };
}

router.get("/orgs/:orgId/bank-transactions", async (req, res) => {
  try {
    const userId = getSessionUserId(req);
    const { orgId } = ListBankTransactionsParams.parse(req.params);
    const { status } = ListBankTransactionsQueryParams.parse(req.query);
    await requirePermission(orgId, userId, "reports.read");

    const filter =
      status === "matched"
        ? sql`${bankTransactionsTable.matchedEntryId} IS NOT NULL`
        : status === "all"
          ? sql`TRUE`
          : sql`${bankTransactionsTable.matchedEntryId} IS NULL`;

    const rows = await db
      .select()
      .from(bankTransactionsTable)
      .where(and(eq(bankTransactionsTable.orgId, orgId), filter))
      .orderBy(bankTransactionsTable.txnDate);

    res.json(
      ListBankTransactionsResponse.parse({ transactions: rows.map(toBankTxn) }),
    );
  } catch (err) {
    sendLedgerError(res, err);
  }
});

router.post(
  "/orgs/:orgId/bank-transactions/:txnId/categorize",
  async (req, res) => {
    try {
      const userId = getSessionUserId(req);
      const { orgId, txnId } = CategorizeBankTransactionParams.parse(req.params);
      const { accountId } = CategorizeBankTransactionBody.parse(req.body);
      await requirePermission(orgId, userId, "ledger.post");

      const [txn] = await db
        .select()
        .from(bankTransactionsTable)
        .where(
          and(
            eq(bankTransactionsTable.orgId, orgId),
            eq(bankTransactionsTable.id, txnId),
          ),
        )
        .limit(1);
      if (!txn) throw new NotFoundError("Bank transaction not found for org.");

      // Idempotent: an already-matched transaction is returned unchanged.
      if (txn.matchedEntryId != null) {
        res.json(CategorizeBankTransactionResponse.parse(toBankTxn(txn)));
        return;
      }
      if (txn.amount === 0n) {
        throw new HttpError(400, "Cannot categorize a zero-amount transaction.");
      }

      const cash = await accountByCode(orgId, "1000");
      const magnitude = txn.amount < 0n ? -txn.amount : txn.amount;
      // Convention: negative = money out. Money out debits the chosen account
      // (e.g. an expense) and credits cash; money in does the reverse.
      const lines =
        txn.amount < 0n
          ? [
              { accountId, debit: magnitude },
              { accountId: cash.id, credit: magnitude },
            ]
          : [
              { accountId: cash.id, debit: magnitude },
              { accountId, credit: magnitude },
            ];

      const updated = await db.transaction(async (tx) => {
        const posted = await postJournalEntry(
          orgId,
          {
            entryDate: txn.txnDate,
            memo: txn.description ?? "Bank transaction",
            source: "bank_reconcile",
            lines,
          },
          { actor: userId, idempotencyKey: `banktxn:${txn.id}`, tx },
        );
        const [row] = await tx
          .update(bankTransactionsTable)
          .set({ matchedEntryId: posted.entry.id, accountId })
          .where(eq(bankTransactionsTable.id, txn.id))
          .returning();
        return row;
      });

      res.json(CategorizeBankTransactionResponse.parse(toBankTxn(updated)));
    } catch (err) {
      sendLedgerError(res, err);
    }
  },
);

router.get("/orgs/:orgId/bank/status", async (req, res) => {
  try {
    const userId = getSessionUserId(req);
    const { orgId } = GetBankStatusParams.parse(req.params);
    await requirePermission(orgId, userId, "reports.read");
    res.json(GetBankStatusResponse.parse(await bankStatus(orgId)));
  } catch (err) {
    sendLedgerError(res, err);
  }
});

router.post("/orgs/:orgId/bank/link-token", async (req, res) => {
  try {
    const userId = getSessionUserId(req);
    const { orgId } = CreateBankLinkTokenParams.parse(req.params);
    await requirePermission(orgId, userId, "ledger.post");
    const linkToken = await createLinkToken(userId);
    res.json(CreateBankLinkTokenResponse.parse({ linkToken }));
  } catch (err) {
    sendLedgerError(res, err);
  }
});

router.post("/orgs/:orgId/bank/exchange", async (req, res) => {
  try {
    const userId = getSessionUserId(req);
    const { orgId } = ExchangeBankTokenParams.parse(req.params);
    const { publicToken } = ExchangeBankTokenBody.parse(req.body);
    await requirePermission(orgId, userId, "ledger.post");

    const { accessToken, itemId } = await exchangePublicToken(publicToken);
    const institutionName = await getInstitutionName(accessToken);

    await db
      .insert(bankConnectionsTable)
      .values({
        orgId,
        plaidItemId: itemId,
        plaidAccessToken: accessToken,
        institutionName,
        cursor: null,
        lastSyncError: null,
      })
      .onConflictDoUpdate({
        target: bankConnectionsTable.orgId,
        set: {
          plaidItemId: itemId,
          plaidAccessToken: accessToken,
          institutionName,
          cursor: null,
          lastSyncError: null,
        },
      });

    res.json(ExchangeBankTokenResponse.parse(await bankStatus(orgId)));
  } catch (err) {
    sendLedgerError(res, err);
  }
});

router.post("/orgs/:orgId/bank/sync", async (req, res) => {
  try {
    const userId = getSessionUserId(req);
    const { orgId } = SyncBankParams.parse(req.params);
    await requirePermission(orgId, userId, "ledger.post");

    const [connection] = await db
      .select()
      .from(bankConnectionsTable)
      .where(eq(bankConnectionsTable.orgId, orgId))
      .limit(1);
    if (!connection) throw new NotFoundError("No bank connected for this org.");

    let added = 0;
    try {
      const result = await syncTransactions(
        connection.plaidAccessToken,
        connection.cursor,
      );

      // Dedup on the Plaid transaction id so re-syncing never re-imports.
      const externalIds = result.added.map((t) => t.transaction_id);
      const existing =
        externalIds.length > 0
          ? await db
              .select({ externalId: bankTransactionsTable.externalId })
              .from(bankTransactionsTable)
              .where(
                and(
                  eq(bankTransactionsTable.orgId, orgId),
                  inArray(bankTransactionsTable.externalId, externalIds),
                ),
              )
          : [];
      const seen = new Set(existing.map((e) => e.externalId));

      const toInsert = result.added
        .filter((t) => !seen.has(t.transaction_id))
        .map((t) => ({
          orgId,
          txnDate: t.date,
          // Plaid: positive = money out. Our convention: negative = money out.
          amount: -BigInt(Math.round(t.amount * 100)),
          description: t.name,
          externalId: t.transaction_id,
        }));

      if (toInsert.length > 0) {
        await db.insert(bankTransactionsTable).values(toInsert);
        added = toInsert.length;
      }

      await db
        .update(bankConnectionsTable)
        .set({
          cursor: result.cursor,
          lastSyncedAt: new Date(),
          lastSyncError: null,
        })
        .where(eq(bankConnectionsTable.orgId, orgId));
    } catch (syncErr) {
      const message =
        syncErr instanceof Error ? syncErr.message : "Bank sync failed.";
      await db
        .update(bankConnectionsTable)
        .set({ lastSyncError: message, lastSyncedAt: new Date() })
        .where(eq(bankConnectionsTable.orgId, orgId));
      throw syncErr;
    }

    res.json(
      SyncBankResponse.parse({ added, status: await bankStatus(orgId) }),
    );
  } catch (err) {
    sendLedgerError(res, err);
  }
});

export default router;
