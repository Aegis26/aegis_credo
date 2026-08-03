---
name: PDF import extraction
description: Lessons from adding PDF trial-balance parsing (pdfjs-dist geometry + esbuild)
---

- **pdfjs-dist must be externalized in the api-server esbuild config** — bundling it silently breaks `getDocument` at runtime (worker/asset resolution). Symptom: parsing works under vitest/tsx but the running server 400s. It stays in `dependencies` so node resolves it from node_modules.
- **PDF table extraction is positional, never content-based**: cells left of the amount-column x-boundary are account text regardless of characters ("401(k) Plan", numeric codes must never be classified as money). Amount cells assign to the nearer header-column center.
- **Multi-page PDFs repeat the column header per page** — skip repeated header lines in the data loop, and stack pages by shifting y-offsets.
- **Hostile-PDF caps are mandatory** on any PDF parse path: bytes (5 MB), pages (50), text items (100k) → friendly 400. Parenthesized negatives normalize to leading minus before `parseDecimalToMinor`.

**Why:** first implementation passed unit tests but failed live (bundling), and code review flagged the content-based classification + DoS exposure.
**How to apply:** any new PDF ingestion surface (e.g. bank statements) reuses these caps and the externalization; test the RUNNING server, not just vitest.
