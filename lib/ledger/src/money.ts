import type { AccountType, NormalBalance } from "@workspace/db";

/**
 * Monetary values are integer minor units (cents) represented as native BigInt.
 * No float or JS number ever appears in the monetary code path.
 */
export type Money = bigint;

/** Guard: value must be a non-negative BigInt (rejects JS number/float). */
export function assertNonNegativeMoney(value: unknown, label: string): Money {
  if (typeof value !== "bigint") {
    throw new TypeError(
      `${label} must be a bigint (integer minor units), got ${typeof value}`,
    );
  }
  if (value < 0n) {
    throw new RangeError(`${label} must be non-negative, got ${value}`);
  }
  return value;
}

/** The side on which each account type normally carries a positive balance. */
export function normalBalanceFor(type: AccountType): NormalBalance {
  switch (type) {
    case "asset":
    case "expense":
      return "debit";
    case "liability":
    case "equity":
    case "revenue":
      return "credit";
  }
}

/**
 * Convert a raw (debit - credit) delta into the account's natural balance,
 * so debit-normal accounts and credit-normal accounts both read as positive
 * when they carry their expected balance.
 */
export function naturalBalance(
  normal: NormalBalance,
  debitMinusCredit: Money,
): Money {
  return normal === "debit" ? debitMinusCredit : -debitMinusCredit;
}
