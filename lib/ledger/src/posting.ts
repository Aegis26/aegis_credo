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

export interface PostOptions {
  actor?: string;
  /** Set internally when posting a reversal so it links to the original. */
  reversesEntryId?: string;
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

  return db.transaction(async (tx) => {
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

    const [entry] = await tx
      .insert(journalEntriesTable)
      .values({
        orgId,
        entryDate: input.entryDate,
        memo: input.memo,
        source: input.source,
        reversesEntryId: options.reversesEntryId,
      })
      .returning();

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
  });
}
