import { HttpError } from "./errors";

/**
 * Parse a decimal money string (e.g. "1234.56") into integer minor units
 * (cents) as a native BigInt. This is the inverse of the ledger's formatMoney
 * and the ONLY place a client-supplied money value crosses into the BigInt
 * monetary path — a JS number never touches it. Rejects anything that is not a
 * plain decimal with up to two fraction digits.
 */
export function parseMoney(input: unknown, label = "amount"): bigint {
  if (typeof input !== "string") {
    throw new HttpError(400, `${label} must be a decimal string.`);
  }
  const trimmed = input.trim();
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!match) {
    throw new HttpError(
      400,
      `${label} must be a decimal string with up to two fraction digits.`,
    );
  }
  const sign = match[1] ? -1n : 1n;
  const whole = BigInt(match[2]);
  const frac = (match[3] ?? "").padEnd(2, "0");
  return sign * (whole * 100n + BigInt(frac));
}

/**
 * Convert a Plaid amount (a JS number, the ONLY place Plaid hands us money) into
 * integer minor units without ever doing float arithmetic on the cents. The
 * number is stringified to a fixed 2-decimal form and then run through the same
 * decimal parser as every other money boundary, so no JS number touches the
 * BigInt path. Plaid amounts are in the account's currency with 2 fraction
 * digits; more precision is rounded at this boundary (documented, deliberate).
 */
export function parsePlaidAmount(amount: number, label = "Plaid amount"): bigint {
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    throw new HttpError(400, `${label} must be a finite number.`);
  }
  return parseMoney(amount.toFixed(2), label);
}
