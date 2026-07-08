/**
 * Serialize a value for storage in a jsonb audit column. BigInt monetary values
 * cannot be JSON-serialized natively, so they are converted to strings while
 * preserving their exact integer value.
 */
export function serializeForAudit<T>(value: T): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, v) =>
      typeof v === "bigint" ? v.toString() : v,
    ),
  );
}
