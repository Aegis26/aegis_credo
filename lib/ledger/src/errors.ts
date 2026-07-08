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
