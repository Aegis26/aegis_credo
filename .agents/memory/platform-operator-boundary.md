---
name: Platform operator boundary
description: Security separation between platform administration and tenant financial authorization.
---

Platform-operator capability must remain a separate authorization path and must never act as tenant membership, a tenant role, or an implicit grant to financial data.

**Why:** Platform support needs metadata and account-lifecycle controls, but cross-tenant financial access would violate the product's isolation model. Environment-selected operator identity also becomes unsafe if a stale session can retain privilege after account changes.

**How to apply:** Keep platform routes separate from tenant permission checks. Every authenticated request must revalidate the persisted email, session version, and active status. Any new user-creation path must reserve the configured operator identity for trusted provisioning only.