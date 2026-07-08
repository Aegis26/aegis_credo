import { db, organizationsTable, auditLogTable } from "@workspace/db";
import { inArray } from "drizzle-orm";
import { serializeForAudit } from "./audit";
import {
  getTrialBalance,
  getProfitAndLoss,
  getBalanceSheet,
} from "./reporting";
import { accessibleClients } from "./practice";
import { ForbiddenError } from "./errors";
import {
  formatMoney,
  type Sheet,
  type Workbook,
  type ExportFormat,
  serializeWorkbook,
  type ExportFile,
} from "./export";

/**
 * Batch operations across a book of clients. Every batch call is access-scoped:
 * the requested client orgs are first filtered to the ones the user actually has
 * an active grant to, so a batch can never touch a client the user wasn't
 * granted. By default an ungranted client in the request is rejected; pass
 * skipUnauthorized to silently drop them instead.
 */

export type BatchReportKind = "trialBalance" | "profitAndLoss" | "balanceSheet";

export interface BatchOptions {
  /** Drop ungranted clients instead of throwing. Default false (strict). */
  skipUnauthorized?: boolean;
}

async function resolveScope(
  userId: string,
  orgIds: string[],
  options: BatchOptions,
): Promise<string[]> {
  const allowed = new Set(await accessibleClients(userId, orgIds));
  if (!options.skipUnauthorized) {
    const denied = orgIds.filter((id) => !allowed.has(id));
    if (denied.length > 0) {
      throw new ForbiddenError(
        `User ${userId} lacks access to clients: ${denied.join(", ")}.`,
      );
    }
  }
  // Preserve caller order, drop duplicates and unauthorized.
  const seen = new Set<string>();
  return orgIds.filter(
    (id) => allowed.has(id) && !seen.has(id) && (seen.add(id), true),
  );
}

async function orgNames(orgIds: string[]): Promise<Map<string, string>> {
  if (orgIds.length === 0) return new Map();
  const rows = await db
    .select({ id: organizationsTable.id, name: organizationsTable.name })
    .from(organizationsTable)
    .where(inArray(organizationsTable.id, orgIds));
  return new Map(rows.map((r) => [r.id, r.name]));
}

export interface BatchReportEntry {
  orgId: string;
  name: string;
  trialBalance?: Awaited<ReturnType<typeof getTrialBalance>>;
  profitAndLoss?: Awaited<ReturnType<typeof getProfitAndLoss>>;
  balanceSheet?: Awaited<ReturnType<typeof getBalanceSheet>>;
}

/** Run the same report across every granted client in the requested book. */
export async function runBatchReport(
  userId: string,
  orgIds: string[],
  kind: BatchReportKind,
  options: BatchOptions = {},
): Promise<BatchReportEntry[]> {
  const scope = await resolveScope(userId, orgIds, options);
  const names = await orgNames(scope);

  const out: BatchReportEntry[] = [];
  for (const orgId of scope) {
    const entry: BatchReportEntry = {
      orgId,
      name: names.get(orgId) ?? orgId,
    };
    if (kind === "trialBalance") {
      entry.trialBalance = await getTrialBalance(orgId);
    } else if (kind === "profitAndLoss") {
      entry.profitAndLoss = await getProfitAndLoss(orgId);
    } else {
      entry.balanceSheet = await getBalanceSheet(orgId);
    }
    out.push(entry);
  }
  return out;
}

function trialBalanceSheet(entry: BatchReportEntry): Sheet {
  return {
    name: entry.name,
    columns: ["Code", "Account", "Type", "Debit", "Credit", "Balance"],
    rows: (entry.trialBalance?.rows ?? []).map((r) => [
      r.code,
      r.name,
      r.type,
      formatMoney(r.debit),
      formatMoney(r.credit),
      formatMoney(r.balance),
    ]),
  };
}

function profitAndLossSheet(entry: BatchReportEntry): Sheet {
  const pl = entry.profitAndLoss;
  return {
    name: entry.name,
    columns: ["Line", "Amount"],
    rows: [
      ["Revenue", formatMoney(pl?.revenue ?? 0n)],
      ["Expenses", formatMoney(pl?.expenses ?? 0n)],
      ["Net income", formatMoney(pl?.netIncome ?? 0n)],
    ],
  };
}

function balanceSheetSheet(entry: BatchReportEntry): Sheet {
  const bs = entry.balanceSheet;
  return {
    name: entry.name,
    columns: ["Line", "Amount"],
    rows: [
      ["Assets", formatMoney(bs?.assets ?? 0n)],
      ["Liabilities", formatMoney(bs?.liabilities ?? 0n)],
      ["Equity (with income)", formatMoney(bs?.equityWithIncome ?? 0n)],
      ["Balances (A = L + E)", bs?.balances ? "YES" : "NO"],
    ],
  };
}

/** Turn batch report entries into an export workbook (one sheet per client). */
export function batchReportToWorkbook(
  entries: BatchReportEntry[],
  kind: BatchReportKind,
): Workbook {
  const toSheet =
    kind === "trialBalance"
      ? trialBalanceSheet
      : kind === "profitAndLoss"
        ? profitAndLossSheet
        : balanceSheetSheet;
  return { sheets: entries.map(toSheet) };
}

export interface BatchExportResult {
  kind: BatchReportKind;
  format: ExportFormat;
  clients: Array<{ orgId: string; name: string }>;
  files: ExportFile[];
}

/**
 * Run a report across a book of granted clients and serialize the whole book to
 * downloadable files (CSV per client, or a single multi-sheet Excel workbook).
 */
export async function batchExport(
  userId: string,
  orgIds: string[],
  kind: BatchReportKind,
  format: ExportFormat = "csv",
  options: BatchOptions = {},
): Promise<BatchExportResult> {
  const entries = await runBatchReport(userId, orgIds, kind, options);

  // Audit the bulk data extraction per client. Export is data leaving the
  // system, so each exported client org gets an access record scoped to it.
  if (entries.length > 0) {
    await db.insert(auditLogTable).values(
      entries.map((e) => ({
        orgId: e.orgId,
        actor: userId,
        action: "practice.client.export",
        entity: "report",
        entityId: kind,
        before: null,
        after: serializeForAudit({
          kind,
          format,
          at: new Date().toISOString(),
        }),
      })),
    );
  }

  const workbook = batchReportToWorkbook(entries, kind);
  return {
    kind,
    format,
    clients: entries.map((e) => ({ orgId: e.orgId, name: e.name })),
    files: serializeWorkbook(workbook, format, kind),
  };
}
