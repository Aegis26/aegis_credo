# Pinned IRS review templates

Public IRS forms, downloaded from the official prior-year archive. These are
used only to embed Copy B in a prominently marked review draft, never as
submission-ready Copy A. No runtime HTTP fetch is used.

| Tax year | Official source | Layout revision | General NEC threshold |
|---|---|---|---|
| 2024 | https://www.irs.gov/pub/irs-prior/f1099nec--2024.pdf | January 2024 | USD 600 |
| 2025 | https://www.irs.gov/pub/irs-prior/f1099nec--2025.pdf | April 2025 | USD 600 |
| 2026 | https://www.irs.gov/pub/irs-prior/f1099nec--2026.pdf | December 2026 | USD 2,000 |

Verify revisions, field names, recipient-copy page index and year-specific
thresholds against IRS instructions whenever adding a supported year:
https://www.irs.gov/instructions/i1099mec
https://www.irs.gov/forms-pubs/about-form-1099-nec

Future inflation-adjusted thresholds are intentionally not guessed.
Unknown TINs, addresses, withholding, state boxes and other amounts stay blank.
Any expansion to TIN/address collection or storage needs explicit approval and
a separate security review first.
