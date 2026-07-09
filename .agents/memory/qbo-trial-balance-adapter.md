---
name: QBO Trial Balance adapter design constraints
description: Non-obvious scoping + money-safety decisions for the vendor-export adapter layer feeding the frozen import engine.
---

# Vendor-export adapter layer (QBO Trial Balance)

Adapters translate a real vendor export → the canonical import body, then feed the
FROZEN import/posting/reconciliation engine. Adapters are pure (no DB, no ledger).

## Adapter is scoped to "one TB → fresh org"

Account codes are assigned deterministically by type band + appearance order
(asset 10000+, liability 20000+, …, clear of seed COA 1000–6300). Re-importing the
SAME export → SAME codes → the by-code upsert is idempotent.

**Why:** importing a *different* second TB into an already-migrated org is out of
scope and cannot be fixed by smarter codes — the frozen engine dedupes only by
content-hash, so a different file posts a SECOND opening-balance entry on top of
the first, doubling balances and breaking reconciliation regardless of codes.
**How to apply:** don't "harden" codes with name-hashing to chase cross-file
collisions; that adds within-file collision risk for a workflow the engine doesn't
support anyway. Migration = one TB into a fresh org; same-file re-upload is safe.

## Money: no float, even for XLSX numeric cells

CSV path is pure string → `parseDecimalToMinor` (integer BigInt, strips commas,
parens-negatives, ≤2 decimals). XLSX cells that are native numbers must be
serialized with `String(value)` (lossless shortest round-trip), NEVER `toFixed(2)`
or `*100` — those introduce float rounding. Values with >2 fraction digits are
then rejected by `parseDecimalToMinor` with a friendly error (float noise can't
sneak in). `parseDecimalToMinor` does NOT strip currency symbols — only commas.

## Reconciliation is source-vs-ledger (stricter with prior activity)

A fresh org reconciles exactly (matched:true). Testing against an org that already
has activity in the same codes shows matched:false — that's the documented
stricter behavior, not a bug. Use a fresh org for clean e2e demos.
