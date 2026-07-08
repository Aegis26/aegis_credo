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
