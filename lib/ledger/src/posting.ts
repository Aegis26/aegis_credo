import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  accountsTable,
  journalEntriesTable,
  journalLinesTable,
  auditLogTable,
  type JournalEntry,
  type JournalLine,
} from "@workspace/db";
import { assertNonNegativeMoney, type Money } from "./money";
import {
  InvalidEntryError,
  InvalidLineError,
  NotFoundError,
  UnbalancedEntryError,
} from "./errors";
import { serializeForAudit } from "./audit";

export interface JournalLineInput {
  accountId: string;
  debit?: Money;
  credit?: Money;
  memo?: string;
}

export interface JournalEntryInput {
  entryDate: string; // YYYY-MM-DD
  memo?: string;
  source: string;
  lines: JournalLineInput[];
}

/** A Drizzle transaction handle, so callers can compose posts atomically. */
export type LedgerTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface PostOptions {
  actor?: string;
  /** Set internally when posting a reversal so it links to the original. */
  reversesEntryId?: string;
  /**
   * Optional idempotency key, unique per org. If an entry with this key already
   * exists, the existing entry is returned unchanged instead of posting a
   * duplicate. Every automated money path (import, bill pay, invoicing,
   * payroll) supplies one so re-runs never double-post.
   */
  idempotencyKey?: string;
  /**
   * Run inside an existing transaction instead of opening a new one. Lets the
   * AP/AR/payroll flows post the ledger entry atomically with their own
   * document-row writes, so a mid-flight failure never strands a record.
   */
  tx?: LedgerTx;
}

export interface PostedEntry {
  entry: JournalEntry;
  lines: JournalLine[];
}

interface NormalizedLine {
  accountId: string;
  debit: Money;
  credit: Money;
  memo?: string;
}

/** Validate and normalize input lines, enforcing balancing and integer money. */
function validateLines(lines: JournalLineInput[]): NormalizedLine[] {
  if (!Array.isArray(lines) || lines.length < 2) {
    throw new InvalidEntryError(
      "A journal entry must have at least two lines (double-entry).",
    );
  }

  let totalDebit = 0n;
  let totalCredit = 0n;
  const normalized: NormalizedLine[] = [];

  for (const [i, line] of lines.entries()) {
    const debit = assertNonNegativeMoney(line.debit ?? 0n, `lines[${i}].debit`);
    const credit = assertNonNegativeMoney(
      line.credit ?? 0n,
      `lines[${i}].credit`,
    );

    const debitSet = debit > 0n;
    const creditSet = credit > 0n;
    if (debitSet === creditSet) {
      throw new InvalidLineError(
        `lines[${i}] must have exactly one of a positive debit or credit amount.`,
      );
    }

    totalDebit += debit;
    totalCredit += credit;
    normalized.push({ accountId: line.accountId, debit, credit, memo: line.memo });
  }

  if (totalDebit !== totalCredit) {
    throw new UnbalancedEntryError(
      `Entry does not balance: debits ${totalDebit} != credits ${totalCredit}.`,
    );
  }
  if (totalDebit === 0n) {
    throw new UnbalancedEntryError("Entry total must be greater than zero.");
  }

  return normalized;
}

/** Load a previously posted entry and its lines, scoped by org. */
export async function loadPostedEntry(
  orgId: string,
  entryId: string,
  tx: LedgerTx | typeof db = db,
): Promise<PostedEntry> {
  const [entry] = await tx
    .select()
    .from(journalEntriesTable)
    .where(
      and(
        eq(journalEntriesTable.orgId, orgId),
        eq(journalEntriesTable.id, entryId),
      ),
    )
    .limit(1);
  if (!entry) {
    throw new NotFoundError(`Journal entry ${entryId} not found for org.`);
  }
  const lines = await tx
    .select()
    .from(journalLinesTable)
    .where(
      and(
        eq(journalLinesTable.orgId, orgId),
        eq(journalLinesTable.entryId, entryId),
      ),
    );
  return { entry, lines };
}

/**
 * Post a balanced journal entry: validates balancing, writes the entry and all
 * of its lines plus an audit_log row in a single atomic transaction.
 */
export async function postJournalEntry(
  orgId: string,
  input: JournalEntryInput,
  options: PostOptions = {},
): Promise<PostedEntry> {
  const normalized = validateLines(input.lines);
  const actor = options.actor ?? "system";

  const run = async (tx: LedgerTx): Promise<PostedEntry> => {
    // Idempotency guard: if an entry with this key already exists for the org,
    // return it unchanged instead of posting a duplicate.
    if (options.idempotencyKey != null) {
      const existing = await loadByKey(tx, orgId, options.idempotencyKey);
      if (existing) return existing;
    }

    // Every referenced account must belong to this org. This gives a clear
    // domain error before hitting the DB-level composite foreign keys.
    const accountIds = [...new Set(normalized.map((l) => l.accountId))];
    const owned = await tx
      .select({ id: accountsTable.id })
      .from(accountsTable)
      .where(
        and(
          eq(accountsTable.orgId, orgId),
          inArray(accountsTable.id, accountIds),
        ),
      );
    if (owned.length !== accountIds.length) {
      throw new NotFoundError(
        "One or more accounts do not exist for this org (cross-tenant references are not allowed).",
      );
    }

    const inserted = await tx
      .insert(journalEntriesTable)
      .values({
        orgId,
        entryDate: input.entryDate,
        memo: input.memo,
        source: input.source,
        idempotencyKey: options.idempotencyKey,
        reversesEntryId: options.reversesEntryId,
      })
      // Race guard: a concurrent post with the same key may have committed
      // between our read above and this insert. onConflictDoNothing turns that
      // into an empty result, which we resolve by loading the winner below.
      .onConflictDoNothing({
        target: [journalEntriesTable.orgId, journalEntriesTable.idempotencyKey],
      })
      .returning();
    const entry = inserted[0];
    if (!entry) {
      const winner =
        options.idempotencyKey != null &&
        (await loadByKey(tx, orgId, options.idempotencyKey));
      if (winner) return winner;
      throw new Error("Failed to insert journal entry.");
    }

    const lines = await tx
      .insert(journalLinesTable)
      .values(
        normalized.map((l) => ({
          orgId,
          entryId: entry.id,
          accountId: l.accountId,
          debit: l.debit,
          credit: l.credit,
          memo: l.memo,
        })),
      )
      .returning();

    await tx.insert(auditLogTable).values({
      orgId,
      actor,
      action: options.reversesEntryId ? "reverse" : "post",
      entity: "journal_entry",
      entityId: entry.id,
      before: null,
      after: serializeForAudit({ entry, lines }),
    });

    return { entry, lines };
  };

  return options.tx ? run(options.tx) : db.transaction(run);
}

/** Load an entry + its lines by idempotency key within a transaction. */
async function loadByKey(
  tx: LedgerTx,
  orgId: string,
  idempotencyKey: string,
): Promise<PostedEntry | undefined> {
  const [entry] = await tx
    .select()
    .from(journalEntriesTable)
    .where(
      and(
        eq(journalEntriesTable.orgId, orgId),
        eq(journalEntriesTable.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  if (!entry) return undefined;
  const lines = await tx
    .select()
    .from(journalLinesTable)
    .where(
      and(
        eq(journalLinesTable.orgId, orgId),
        eq(journalLinesTable.entryId, entry.id),
      ),
    );
  return { entry, lines };
}
