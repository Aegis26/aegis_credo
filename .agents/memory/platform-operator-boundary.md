---
name: Platform operator boundary
description: Security separation between platform administration and tenant financial authorization.
---

Platform-operator capability must remain a separate authorization path and must never act as tenant membership, a tenant role, or an implicit grant to financial data.

**Why:** Platform support needs metadata and account-lifecycle controls, but cross-tenant financial access would violate the product's isolation model. Environment-selected operator identity also becomes unsafe if a stale session can retain privilege after account changes.

**How to apply:** Keep platform routes separate from tenant permission checks. Every authenticated request must revalidate the persisted email, session version, and active status. Any new user-creation path must reserve the configured operator identity for trusted provisioning only.

The configured operator account is data, not configuration: provisioning it in development after production already exists does not create it in production. Provision the production row separately through the production data editor without replacing or reseeding existing production data.

**Why:** Replit production databases retain their own records after initial provisioning; later development data changes are not copied during publish.

**How to apply:** When operator login works in development but production records `no_such_user`, verify production read-only first, then have the user add only the operator row through the production database editor. Never bypass production write restrictions with a script or temporary endpoint.