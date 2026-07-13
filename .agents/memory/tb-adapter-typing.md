---
name: TB adapter typing principles
description: User-confirmed rules for vendor trial-balance import adapters — typing correctness, ambiguity handling, zero-balance rows.
---

- **Balanced ≠ correct.** A trial-balance import can reconcile perfectly while
  every account is mistyped. Tests for adapters must assert account TYPE, not
  just totals.
  **Why:** user rejected an earlier pass where the file imported and balanced
  but expenses landed as Assets.
  **How to apply:** any new adapter (Xero, etc.) needs type assertions against
  a realistic fixture, and reviews should not accept "it reconciles" as proof.
- **Never silently default an unresolved account type.** Surface it as
  ambiguous and force an explicit user choice (empty dropdown, import gated).
  Best-guess is fine as a candidate, never as a silent final answer.
- **Name-only / 0.00 rows in a QBO TB are real zero-balance accounts**, not
  section headers — keep them in the chart of accounts, exclude them from the
  opening journal entry (the posting engine rejects zero lines).
- **QBO colon hierarchy (`Parent:Child`) inherits type from the parent**,
  resolved root-first — QBO enforces that sub-accounts share the parent's
  type, so the parent keyword beats anything in the child segment.
