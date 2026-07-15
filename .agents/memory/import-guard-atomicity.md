---
name: Import guard atomicity & net reconciliation
description: Why the multi-import opening-balance guard needs an advisory-lock transaction, and why reconciliation must compare net (not gross) per account.
---

**Rule 1: check-then-act guards over the ledger must run inside one transaction
under a per-scope Postgres advisory lock** (`pg_advisory_xact_lock(hashtext(tag),
hashtext(orgId))`), with the check re-run inside the tx.

**Why:** a pre-check outside a transaction is a TOCTOU race — two concurrent
imports both saw "no existing opening balances" and both posted, doubling the
books. Architect review flagged it; a `Promise.allSettled` parallel-import test
reproduces it deterministically.

**How to apply:** keep a cheap no-side-effect pre-check for fast UX, but treat
only the in-tx re-check as authoritative. Thread the tx through every helper
(`reverseJournalEntry`, `postJournalEntry` via `options.tx`) so replace
(reverse-all + post-new) rolls back as a unit.

**Rule 2: reconciliation must compare NET movement per account (debit − credit,
shown on the natural side), never gross column totals.**

**Why:** a reversal pair (original + reversing entry) inflates gross debits and
credits equally but nets to zero — gross comparison made every post-replace
reconciliation fail even though the books were correct. Net comparison keeps
the check strict for real prior activity (it doesn't net away) while making
append-only reversals invisible.
