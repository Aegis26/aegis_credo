/**
 * Demo: stand up an accounting practice with one accountant granted access to
 * three client orgs (and pointedly NOT a fourth). Post some ledger activity,
 * open a month-end close per client, run a cross-client batch export, and print
 * a practice-level dashboard across every granted client — proving the
 * accountant sees only their book and never the ungranted client.
 *
 * Run: pnpm --filter @workspace/ledger run demo:practice
 */
import { pool } from "@workspace/db";
import { seedOrganization } from "./seed";
import { upsertUser } from "./access";
import { postJournalEntry } from "./posting";
import {
  createPractice,
  addPracticeMember,
  grantClientAccess,
  switchToClient,
  hasClientAccess,
  listClientsForPracticeUser,
} from "./practice";
import {
  createClosePeriod,
  addCloseTask,
  setCloseTaskStatus,
  setClosePeriodStatus,
  createPbcRequest,
  respondPbcRequest,
} from "./close";
import { batchExport } from "./batch";
import { getPracticeDashboard } from "./dashboard";
import { formatMoney } from "./export";
import type { Money } from "./money";

const pad = (s: string, n: number): string => s.padEnd(n);
const padL = (s: string, n: number): string => s.padStart(n);

async function main(): Promise<void> {
  // The practice and its one accountant.
  const practice = await createPractice("Northwind Accounting");
  // Unique per run so repeated demos don't accumulate grants on one user (the
  // switcher legitimately spans every practice a user belongs to).
  const accountant = await upsertUser(
    `dana-${Date.now()}@northwind.cpa`,
    "Dana (Accountant)",
  );
  await addPracticeMember(practice.id, accountant.id, { role: "owner" });

  // Three client orgs the practice is granted; one it is NOT.
  const acme = await seedOrganization("Acme Retail");
  const bravo = await seedOrganization("Bravo Foods");
  const citrus = await seedOrganization("Citrus Design");
  const outsider = await seedOrganization("Outsider LLC (ungranted)");

  const clients: Array<[Awaited<ReturnType<typeof seedOrganization>>, Money, string]> = [
    [acme, 100_000n, "acme"],
    [bravo, 60_000n, "bravo"],
    [citrus, 40_000n, "citrus"],
  ];

  for (const [client] of clients) {
    await grantClientAccess(practice.id, client.organization.id, {
      actor: "demo",
      grantedBy: accountant.id,
    });
  }

  // A little ledger activity in each granted client: a cash sale + rent expense.
  for (const [client, sale, key] of clients) {
    await postJournalEntry(
      client.organization.id,
      {
        entryDate: "2026-01-15",
        memo: "Cash sale",
        source: "manual",
        lines: [
          { accountId: client.byCode["1000"].id, debit: sale },
          { accountId: client.byCode["4000"].id, credit: sale },
        ],
      },
      { idempotencyKey: `${key}-sale`, actor: "demo" },
    );
    await postJournalEntry(
      client.organization.id,
      {
        entryDate: "2026-01-20",
        memo: "Office rent",
        source: "manual",
        lines: [
          { accountId: client.byCode["6400"].id, debit: 20_000n },
          { accountId: client.byCode["1000"].id, credit: 20_000n },
        ],
      },
      { idempotencyKey: `${key}-rent`, actor: "demo" },
    );
  }

  // Month-end close per client, at varying stages of completion.
  for (const [i, [client]] of clients.entries()) {
    const period = await createClosePeriod(client.organization.id, "2026-01", {
      actor: "demo",
    });
    const t1 = await addCloseTask(
      client.organization.id,
      period.id,
      "Reconcile bank",
      { actor: "demo", sortOrder: 1 },
    );
    const t2 = await addCloseTask(
      client.organization.id,
      period.id,
      "Review AR aging",
      { actor: "demo", sortOrder: 2 },
    );
    await addCloseTask(client.organization.id, period.id, "Post accruals", {
      actor: "demo",
      sortOrder: 3,
    });

    // Advance each client's close a different amount.
    await setCloseTaskStatus(client.organization.id, t1.id, "done", {
      actor: "demo",
    });
    if (i >= 1) {
      await setCloseTaskStatus(client.organization.id, t2.id, "done", {
        actor: "demo",
      });
    }
    if (i >= 1) {
      await setClosePeriodStatus(
        client.organization.id,
        period.id,
        "in_progress",
        { actor: "demo" },
      );
    }

    // A PBC request the client responds to (accountant still to accept).
    const req = await createPbcRequest(
      client.organization.id,
      period.id,
      "Send January bank statement",
      { actor: "demo", detail: "PDF from online banking" },
    );
    if (i === 0) {
      await respondPbcRequest(
        client.organization.id,
        req.id,
        "Uploaded to portal",
        { actor: "client" },
      );
    }
  }

  // The accountant explicitly switches into each granted client (audited).
  console.log(`\nPractice "${practice.name}" — accountant ${accountant.name}`);
  const book = await listClientsForPracticeUser(accountant.id);
  console.log(`Granted clients (${book.length}):`);
  for (const c of book) {
    const org = await switchToClient(accountant.id, c.orgId, { actor: "demo" });
    console.log(`  • switched into ${org.name}`);
  }

  // Prove the ungranted client is invisible / inaccessible.
  const canSeeOutsider = await hasClientAccess(
    accountant.id,
    outsider.organization.id,
  );
  console.log(
    `\nAccess to ungranted "${outsider.organization.name}": ${
      canSeeOutsider ? "VISIBLE ✗" : "hidden ✓"
    }`,
  );
  let batchBlocked = false;
  try {
    await batchExport(
      accountant.id,
      [acme.organization.id, outsider.organization.id],
      "trialBalance",
    );
  } catch {
    batchBlocked = true;
  }
  console.log(
    `Batch export including the ungranted client: ${
      batchBlocked ? "rejected ✓" : "allowed ✗"
    }`,
  );

  // Cross-client batch export (one CSV per client).
  const csvBundle = await batchExport(
    accountant.id,
    book.map((c) => c.orgId),
    "trialBalance",
    "csv",
  );
  console.log(
    `\nBatch CSV export — ${csvBundle.files.length} files for ${csvBundle.clients.length} clients:`,
  );
  for (const f of csvBundle.files) {
    console.log(`  • ${f.name} (${f.content.split("\r\n").length} rows)`);
  }

  // Single multi-sheet Excel workbook across the whole book.
  const xls = await batchExport(
    accountant.id,
    book.map((c) => c.orgId),
    "profitAndLoss",
    "excel",
  );
  console.log(
    `Batch Excel export — 1 workbook, ${xls.clients.length} sheets (${xls.files[0].name})`,
  );

  // Practice-level dashboard across all granted clients.
  const dash = await getPracticeDashboard(accountant.id, practice.id);
  console.log(`\nPractice dashboard — ${dash.clientCount} clients`);
  const header =
    pad("Client", 16) +
    pad("Close", 14) +
    pad("Tasks", 9) +
    pad("PBC", 6) +
    padL("Net income", 14) +
    padL("Balanced", 11);
  console.log(header);
  console.log("-".repeat(header.length));
  for (const c of dash.clients) {
    const tasks = `${c.close.tasksDone}/${c.close.tasksTotal}`;
    console.log(
      pad(c.name, 16) +
        pad(c.close.status ?? "-", 14) +
        pad(tasks, 9) +
        pad(String(c.close.openPbc), 6) +
        padL(formatMoney(c.financials.netIncome), 14) +
        padL(c.financials.balanced ? "YES ✓" : "NO ✗", 11),
    );
  }

  const allBalanced = dash.clients.every((c) => c.financials.balanced);
  const walledOff = !canSeeOutsider && batchBlocked && dash.clientCount === 3;
  await pool.end();
  process.exit(allBalanced && walledOff ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
