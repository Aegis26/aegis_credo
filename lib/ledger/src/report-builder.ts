import { and, eq, inArray, gte, lte } from "drizzle-orm";
import {
  db,
  accountsTable,
  journalLinesTable,
  journalEntriesTable,
  dimensionsTable,
  organizationsTable,
  reportDefinitionsTable,
  auditLogTable,
  type AccountType,
  type NormalBalance,
  type ReportDefinitionRow,
} from "@workspace/db";
import { naturalBalance, type Money } from "./money";
import { NotFoundError, ForbiddenError } from "./errors";
import { serializeForAudit } from "./audit";
import { listOrgsInGroup } from "./consolidation";

/** A field the report can group rows by. */
export type ReportGroupBy =
  | "account"
  | "accountType"
  | "class"
  | "department"
  | "location"
  | "entity";

export interface ReportFilters {
  /** Inclusive entry-date lower bound (YYYY-MM-DD). */
  dateFrom?: string;
  /** Inclusive entry-date upper bound (YYYY-MM-DD). */
  dateTo?: string;
  accountTypes?: AccountType[];
  classIds?: string[];
  departmentIds?: string[];
  locationIds?: string[];
}

/**
 * A custom report query. Scope is exactly one of `orgId` (single entity) or
 * `groupId` (all entities in a group). Rows are grouped by the requested fields
 * and can be filtered by date, account type, and dimension values.
 */
export interface ReportQuery {
  orgId?: string;
  groupId?: string;
  groupBy: ReportGroupBy[];
  filters?: ReportFilters;
}

export interface ReportRow {
  /** One label per groupBy field; "(unassigned)" when a dimension is untagged. */
  keys: Record<ReportGroupBy, string>;
  debit: Money;
  credit: Money;
  /** Sum of per-line natural balances (debit-normal minus credit-normal). */
  balance: Money;
}

export interface ReportResult {
  rows: ReportRow[];
  totalDebit: Money;
  totalCredit: Money;
}

const UNASSIGNED = "(unassigned)";

interface LineRow {
  orgId: string;
  code: string;
  accountName: string;
  type: AccountType;
  normalBalance: NormalBalance;
  classId: string | null;
  departmentId: string | null;
  locationId: string | null;
  debit: bigint;
  credit: bigint;
}

async function resolveScopeOrgs(query: ReportQuery): Promise<string[]> {
  if ((query.orgId == null) === (query.groupId == null)) {
    throw new Error(
      "Report scope must be exactly one of orgId or groupId.",
    );
  }
  if (query.orgId) return [query.orgId];
  return listOrgsInGroup(query.groupId!);
}

/**
 * Guard against a saved definition reading another tenant's data: a definition
 * owned by `ownerOrgId` may only scope to that same org, or to a group the org
 * is actually a member of. Enforced both when saving and when re-running.
 */
async function assertDefinitionScope(
  ownerOrgId: string,
  def: ReportQuery,
): Promise<void> {
  if ((def.orgId == null) === (def.groupId == null)) {
    throw new Error("Report scope must be exactly one of orgId or groupId.");
  }
  if (def.orgId && def.orgId !== ownerOrgId) {
    throw new ForbiddenError(
      "Report definition org scope must match its owner org.",
    );
  }
  if (def.groupId) {
    const members = await listOrgsInGroup(def.groupId);
    if (!members.includes(ownerOrgId)) {
      throw new ForbiddenError(
        "Report definition group scope must include its owner org.",
      );
    }
  }
}

/**
 * Run a custom report. Aggregates posted journal lines across the scope, applies
 * filters, and groups by the requested fields. Because every line is counted
 * exactly once (untagged lines fall into "(unassigned)"), the debit/credit
 * totals always reconcile to the underlying trial balance.
 */
export async function runReport(query: ReportQuery): Promise<ReportResult> {
  const orgs = await resolveScopeOrgs(query);
  if (orgs.length === 0) {
    return { rows: [], totalDebit: 0n, totalCredit: 0n };
  }
  const f = query.filters ?? {};

  const conds = [inArray(accountsTable.orgId, orgs)];
  if (f.dateFrom) conds.push(gte(journalEntriesTable.entryDate, f.dateFrom));
  if (f.dateTo) conds.push(lte(journalEntriesTable.entryDate, f.dateTo));
  if (f.accountTypes?.length) {
    conds.push(inArray(accountsTable.type, f.accountTypes));
  }
  if (f.classIds?.length) {
    conds.push(inArray(journalLinesTable.classId, f.classIds));
  }
  if (f.departmentIds?.length) {
    conds.push(inArray(journalLinesTable.departmentId, f.departmentIds));
  }
  if (f.locationIds?.length) {
    conds.push(inArray(journalLinesTable.locationId, f.locationIds));
  }

  const lines: LineRow[] = await db
    .select({
      orgId: journalLinesTable.orgId,
      code: accountsTable.code,
      accountName: accountsTable.name,
      type: accountsTable.type,
      normalBalance: accountsTable.normalBalance,
      classId: journalLinesTable.classId,
      departmentId: journalLinesTable.departmentId,
      locationId: journalLinesTable.locationId,
      debit: journalLinesTable.debit,
      credit: journalLinesTable.credit,
    })
    .from(journalLinesTable)
    .innerJoin(
      accountsTable,
      and(
        eq(journalLinesTable.orgId, accountsTable.orgId),
        eq(journalLinesTable.accountId, accountsTable.id),
      ),
    )
    .innerJoin(
      journalEntriesTable,
      and(
        eq(journalLinesTable.orgId, journalEntriesTable.orgId),
        eq(journalLinesTable.entryId, journalEntriesTable.id),
      ),
    )
    .where(and(...conds));

  // Label lookups: dimension ids -> names, org ids -> names.
  const dimRows = await db
    .select({
      id: dimensionsTable.id,
      name: dimensionsTable.name,
    })
    .from(dimensionsTable)
    .where(inArray(dimensionsTable.orgId, orgs));
  const dimName = new Map(dimRows.map((d) => [d.id, d.name]));

  const orgRows = await db
    .select({ id: organizationsTable.id, name: organizationsTable.name })
    .from(organizationsTable)
    .where(inArray(organizationsTable.id, orgs));
  const orgName = new Map(orgRows.map((o) => [o.id, o.name]));

  const labelFor = (dim: ReportGroupBy, l: LineRow): string => {
    switch (dim) {
      case "account":
        return `${l.code} ${l.accountName}`;
      case "accountType":
        return l.type;
      case "class":
        return l.classId ? (dimName.get(l.classId) ?? UNASSIGNED) : UNASSIGNED;
      case "department":
        return l.departmentId
          ? (dimName.get(l.departmentId) ?? UNASSIGNED)
          : UNASSIGNED;
      case "location":
        return l.locationId
          ? (dimName.get(l.locationId) ?? UNASSIGNED)
          : UNASSIGNED;
      case "entity":
        return orgName.get(l.orgId) ?? l.orgId;
    }
  };

  const groups = new Map<string, ReportRow>();
  let totalDebit = 0n;
  let totalCredit = 0n;

  for (const l of lines) {
    const keys = {} as Record<ReportGroupBy, string>;
    for (const dim of query.groupBy) keys[dim] = labelFor(dim, l);
    const key = query.groupBy.map((d) => keys[d]).join("\u0000");

    let row = groups.get(key);
    if (!row) {
      row = { keys, debit: 0n, credit: 0n, balance: 0n };
      groups.set(key, row);
    }
    row.debit += l.debit;
    row.credit += l.credit;
    row.balance += naturalBalance(l.normalBalance, l.debit - l.credit);
    totalDebit += l.debit;
    totalCredit += l.credit;
  }

  const rows = [...groups.values()].sort((a, b) => {
    for (const d of query.groupBy) {
      const cmp = a.keys[d].localeCompare(b.keys[d]);
      if (cmp !== 0) return cmp;
    }
    return 0;
  });

  return { rows, totalDebit, totalCredit };
}

/** Persist a report query so it can be re-run later. Audit-logged. */
export async function saveReportDefinition(
  orgId: string,
  name: string,
  definition: ReportQuery,
  options: { createdBy?: string; actor?: string } = {},
): Promise<ReportDefinitionRow> {
  const actor = options.actor ?? "system";
  await assertDefinitionScope(orgId, definition);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(reportDefinitionsTable)
      .values({ orgId, name, definition, createdBy: options.createdBy })
      .returning();

    await tx.insert(auditLogTable).values({
      orgId,
      actor,
      action: "report.save",
      entity: "report_definition",
      entityId: row.id,
      before: null,
      after: serializeForAudit(row),
    });

    return row;
  });
}

/** Load a saved report definition, scoped to its org. */
export async function getReportDefinition(
  orgId: string,
  id: string,
): Promise<ReportDefinitionRow> {
  const [row] = await db
    .select()
    .from(reportDefinitionsTable)
    .where(
      and(
        eq(reportDefinitionsTable.orgId, orgId),
        eq(reportDefinitionsTable.id, id),
      ),
    )
    .limit(1);
  if (!row) throw new NotFoundError(`Report definition ${id} not found.`);
  return row;
}

/** Load and run a saved report definition. */
export async function runSavedReport(
  orgId: string,
  id: string,
): Promise<ReportResult> {
  const row = await getReportDefinition(orgId, id);
  const definition = row.definition as ReportQuery;
  await assertDefinitionScope(orgId, definition);
  return runReport(definition);
}
