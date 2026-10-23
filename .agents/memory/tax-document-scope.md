---
name: Tax document scope and sensitive identity data
description: Owner-approved boundaries for draft-only tax document generation and future tax PII storage.
---

Tax Forms is document generation from existing ledger facts, not tax preparation.
Keep the existing Taxes set-aside estimator untouched and separate. Preserve the
framing “Potential 1099 recipients — review required” and the option to review
below-threshold vendors. Never silently guess a future year's reporting threshold.

Do not collect or store contractor TINs or addresses in this scope. Before any
future expansion, flag it to the user and obtain approval for its own security
review, including encryption at rest and access scoping, with the same care given
to Plaid tokens.

**Why:** The user explicitly approved ledger-only drafts with missing information
blank/flagged and stated that contractor TINs are sensitive PII requiring a
separate security review.

**How to apply:** Keep every generated page visibly draft-only. No liability
calculations, e-filing, agency submissions, depreciation, or invented figures/IDs.
Require the owner's verification against real ledger data before trust.
