export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Thrown when a journal entry's debits do not equal its credits. */
export class UnbalancedEntryError extends LedgerError {}

/** Thrown when a line is malformed (not a bigint, negative, or not debit-xor-credit). */
export class InvalidLineError extends LedgerError {}

/** Thrown when an entry has too few lines to be a valid double-entry posting. */
export class InvalidEntryError extends LedgerError {}

/** Thrown when a referenced entity cannot be found within the given org. */
export class NotFoundError extends LedgerError {}

/** Thrown when attempting to reverse an entry that has already been reversed. */
export class AlreadyReversedError extends LedgerError {}

/** Thrown when a user/actor lacks permission for an action in an org. */
export class ForbiddenError extends LedgerError {}

/** Thrown when import/source data is malformed or internally inconsistent. */
export class ImportError extends LedgerError {}

/**
 * Thrown when an import carrying opening balances targets an org that already
 * has un-reversed imported opening balances from a DIFFERENT file. Silently
 * posting a second opening entry would double the books, so the caller must
 * explicitly choose: cancel, import into a new org, or replace (reverse the
 * prior opening entries first).
 */
export class ImportOpeningConflictError extends LedgerError {
  constructor(
    message: string,
    /** Ids of the existing un-reversed opening entries that block the import. */
    public readonly existingEntryIds: string[] = [],
  ) {
    super(message);
  }
}

/**
 * Thrown when an action is blocked because a configured approval rule requires
 * sign-off that has not been granted (e.g. paying a bill over the threshold).
 */
export class ApprovalRequiredError extends LedgerError {}
