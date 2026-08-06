/**
 * Idempotently add missing default chart-of-accounts entries to an existing
 * org. Usage: pnpm --filter @workspace/ledger run seed:missing-defaults <orgId>
 */
import { seedMissingDefaultAccounts } from "./seed";

const orgId = process.argv[2];
if (!orgId) {
  console.error("Usage: seed:missing-defaults <orgId>");
  process.exit(1);
}

const added = await seedMissingDefaultAccounts(orgId, "seed-missing-defaults-script");
if (added.length === 0) {
  console.log("No accounts added — the org already has every default code.");
} else {
  console.log(`Added ${added.length} account(s):`);
  for (const a of added) console.log(`  ${a.code}  ${a.name}  (${a.type})`);
}
process.exit(0);
