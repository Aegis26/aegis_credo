import { and, eq } from "drizzle-orm";
import {
  db,
  journalEntriesTable,
  journalLinesTable,
} from "@workspace/db";
import { AlreadyReversedError, NotFoundError } from "./errors";
import { postJournalEntry, type PostedEntry, type LedgerTx } from "./posting";

/**
 * Create a balanced reversing entry for a previously posted entry. The original
 * entry and its lines are never modified — reversal is a brand-new entry whose
 * debits/credits are swapped and which references the original.
 */
export async function reverseJournalEntry(
  orgId: string,
  entryId: string,
  reason: string,
  actor = "system",
  tx?: LedgerTx,
): Promise<PostedEntry> {
  const dbc = tx ?? db;
  // Scope strictly by orgId so one tenant cannot reverse another's entry.
  const [original] = await dbc
    .select()
    .from(journalEntriesTable)
    .where(
      and(
        eq(journalEntriesTable.orgId, orgId),
        eq(journalEntriesTable.id, entryId),
      ),
    )
    .limit(1);

  if (!original) {
    throw new NotFoundError(`Journal entry ${entryId} not found for org.`);
  }

  const [existingReversal] = await dbc
    .select({ id: journalEntriesTable.id })
    .from(journalEntriesTable)
    .where(
      and(
        eq(journalEntriesTable.orgId, orgId),
        eq(journalEntriesTable.reversesEntryId, entryId),
      ),
    )
    .limit(1);

  if (existingReversal) {
    throw new AlreadyReversedError(
      `Journal entry ${entryId} has already been reversed.`,
    );
  }

  const originalLines = await dbc
    .select()
    .from(journalLinesTable)
    .where(
      and(
        eq(journalLinesTable.orgId, orgId),
        eq(journalLinesTable.entryId, entryId),
      ),
    );

  return postJournalEntry(
    orgId,
    {
      entryDate: original.entryDate,
      memo: `Reversal of ${entryId}: ${reason}`,
      source: "reversal",
      lines: originalLines.map((l) => ({
        accountId: l.accountId,
        // Swap sides to reverse the effect.
        debit: l.credit,
        credit: l.debit,
        memo: l.memo ?? undefined,
      })),
    },
    { actor, reversesEntryId: entryId, tx },
  );
}
