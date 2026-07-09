import type { AccountType, NormalBalance } from "@workspace/db";

/**
 * Monetary values are integer minor units (cents) represented as native BigInt.
 * No float or JS number ever appears in the monetary code path.
 */
export type Money = bigint;

/**
 * Parse a human-typed decimal money string (dollars) into integer minor units
 * (cents) as a native BigInt, WITHOUT ever touching a JS float. Accepts thousands
 * separators ("1,201.00"), an optional leading sign, and parenthesised negatives
 * ("(370.94)" as used by some exports). Up to two fraction digits. This is the
 * canonical dollars->minor path shared by vendor-export adapters; anything that
 * is not a plain decimal is rejected with a clear message.
 */
export function parseDecimalToMinor(input: string, label = "amount"): Money {
  if (typeof input !== "string") {
    throw new TypeError(`${label} must be a string, got ${typeof input}`);
  }
  const stripped = input.trim().replace(/,/g, "");
  const parenNegative = /^\(.*\)$/.test(stripped);
  const body = parenNegative ? stripped.slice(1, -1).trim() : stripped;
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(body);
  if (!match) {
    throw new RangeError(`${label} is not a valid amount: "${input}"`);
  }
  const negative = parenNegative || match[1] === "-";
  const whole = BigInt(match[2]);
  const frac = (match[3] ?? "").padEnd(2, "0");
  const magnitude = whole * 100n + BigInt(frac);
  return negative ? -magnitude : magnitude;
}

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

/** Guard: value must be a strictly positive BigInt (rejects JS number/float). */
export function assertPositiveMoney(value: unknown, label: string): Money {
  const v = assertNonNegativeMoney(value, label);
  if (v === 0n) {
    throw new RangeError(`${label} must be greater than zero`);
  }
  return v;
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
