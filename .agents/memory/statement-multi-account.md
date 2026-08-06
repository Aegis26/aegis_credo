---
name: Multi-account statement import invariants
description: Decisions for the multi-account bank-statement PDF import (balance invariant, transfer flags, dedup, RBAC)
---

- **Extraction-fidelity invariant:** confirm requires per-account opening/closing balances; server verifies opening + Σ ALL rows (including `excluded` ones) = closing. Excluding a row (transfer leg) is a review decision, not a correction — UI computes the same check over all rows so exclusion never "unbalances" an account.
  **Why:** review round flagged that UI-only balance checks let misread statements import; excluded transfer legs must not defeat the check.
  **How to apply:** any new import path that lets users drop rows must still tie the full row set to the statement.
- **Transfer detection is flag-only** (v1): equal magnitude, ±1 day, description must reference the other account's name tokens or last4; generic tokens (CHECKING/SAVINGS/MONEY/MARKET…) excluded from matching. Never auto-post.
- **Dedup key for statement rows:** `NORMALIZED_ACCTNAME LAST4|date|amount|NORMNAME` — account identity prefix keeps identical txns in sibling accounts distinct; accepted tradeoff: no collision with Plaid keys.
- **RBAC:** inline chart-of-accounts creation on confirm needs `coa.manage` (owner-only permission added to lib/ledger access) — `ledger.post` (staff) is not enough for COA mutation.
- **Cash-account mapping:** `bank_transactions.cash_account_id` nullable; categorize falls back to code-1000 when null (legacy rows).
