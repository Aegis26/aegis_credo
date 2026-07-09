---
name: Plaid import & PFC→COA mapping gotchas
description: Non-obvious traps when mapping Plaid personal_finance_category to the chart of accounts and deduping imported bank transactions.
---

## RENT_AND_UTILITIES substring trap
The Plaid PFC `primary` value `RENT_AND_UTILITIES` itself starts with the letters `RENT`, and its `detailed` values are prefixed with the primary (e.g. `RENT_AND_UTILITIES_GAS_AND_ELECTRICITY`, `RENT_AND_UTILITIES_RENT`). So a naive `detailed.includes("RENT")` matches EVERY utility as rent.

**Rule:** to split rent vs utilities, test the rent-specific suffix (`detailed.endsWith("_RENT")`), never a bare `"RENT"` substring.
**How to apply:** any time you branch a PFC category on its `detailed` string, check that the substring you test isn't also present in the shared primary prefix.

## Prefer null over a wrong suggestion
Transfers, credit-card payments, and loan payments (`CD DEPOSIT`, `CREDIT CARD ... PAYMENT`, `AUTOMATIC PAYMENT`) have no clean expense/revenue home. The mapper returns `null` for these so they surface for manual categorization instead of polluting P&L. A wrong auto-suggestion is worse than none.

## Content-based dedup tradeoff
Imported bank txns are deduped on a content key `date|signed_amount|normalized_name` (unique per org), NOT on Plaid's transaction id — because re-linking a sandbox/item rotates the ids, and id-based dedup would re-import everything on reconnect.
**Why:** the requirement is "reconnect must not re-import." Content dedup survives id rotation.
**Tradeoff:** two genuinely distinct same-day charges from the same merchant for the identical amount collapse into one row. Accepted for this app; revisit if false-merges matter.

## Opening balance idempotency
The bank opening entry (Dr Cash 1000 / Cr Owner's Equity 3000) posts once per connection, guarded by `connection.openingBalanceEntryId` AND ledger idempotency key `bankopening:${orgId}`. The guard column is preserved across re-link so reconnecting never re-posts it. Because `postJournalEntry` is race-safe on `(orgId, idempotencyKey)`, concurrent/repeat exchange calls also can't double-post.
