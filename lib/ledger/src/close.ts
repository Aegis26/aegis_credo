import { and, eq, asc } from "drizzle-orm";
import {
  db,
  closePeriodsTable,
  closeTasksTable,
  pbcRequestsTable,
  auditLogTable,
  type ClosePeriod,
  type CloseTask,
  type CloseTaskStatus,
  type CloseStatus,
  type PbcRequest,
} from "@workspace/db";
import { NotFoundError } from "./errors";
import { serializeForAudit } from "./audit";

/**
 * Month-end close management for a single client org. All functions are scoped
 * to the client org and audit-logged against it; none touch the ledger. Callers
 * must gate access with assertClientAccess (practice.ts) first.
 */

/** Create a close period (e.g. "2026-01") for a client. Audit-logged. */
export async function createClosePeriod(
  orgId: string,
  period: string,
  options: { actor?: string } = {},
): Promise<ClosePeriod> {
  const actor = options.actor ?? "system";
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(closePeriodsTable)
      .values({ orgId, period })
      .returning();

    await tx.insert(auditLogTable).values({
      orgId,
      actor,
      action: "close.period.create",
      entity: "close_period",
      entityId: row.id,
      before: null,
      after: serializeForAudit(row),
    });

    return row;
  });
}

async function loadPeriod(
  orgId: string,
  periodId: string,
): Promise<ClosePeriod> {
  const [row] = await db
    .select()
    .from(closePeriodsTable)
    .where(
      and(
        eq(closePeriodsTable.orgId, orgId),
        eq(closePeriodsTable.id, periodId),
      ),
    )
    .limit(1);
  if (!row) throw new NotFoundError(`Close period ${periodId} not found.`);
  return row;
}

/** Set the overall status of a close period. Records closedAt/closedBy on close. */
export async function setClosePeriodStatus(
  orgId: string,
  periodId: string,
  status: CloseStatus,
  options: { actor?: string; closedBy?: string } = {},
): Promise<ClosePeriod> {
  const actor = options.actor ?? "system";
  return db.transaction(async (tx) => {
    const existing = await loadPeriod(orgId, periodId);
    const [row] = await tx
      .update(closePeriodsTable)
      .set({
        status,
        closedAt: status === "closed" ? new Date() : null,
        closedBy: status === "closed" ? options.closedBy : null,
      })
      .where(eq(closePeriodsTable.id, periodId))
      .returning();

    await tx.insert(auditLogTable).values({
      orgId,
      actor,
      action: "close.period.status",
      entity: "close_period",
      entityId: row.id,
      before: serializeForAudit(existing),
      after: serializeForAudit(row),
    });

    return row;
  });
}

/** Add a checklist task to a close period. Audit-logged. */
export async function addCloseTask(
  orgId: string,
  periodId: string,
  title: string,
  options: { actor?: string; sortOrder?: number } = {},
): Promise<CloseTask> {
  const actor = options.actor ?? "system";
  return db.transaction(async (tx) => {
    // Ensure the period belongs to this org before attaching a task.
    await loadPeriod(orgId, periodId);
    const [row] = await tx
      .insert(closeTasksTable)
      .values({
        orgId,
        periodId,
        title,
        sortOrder: options.sortOrder ?? 0,
      })
      .returning();

    await tx.insert(auditLogTable).values({
      orgId,
      actor,
      action: "close.task.add",
      entity: "close_task",
      entityId: row.id,
      before: null,
      after: serializeForAudit(row),
    });

    return row;
  });
}

/** Update a checklist task's status. Records completion metadata when done. */
export async function setCloseTaskStatus(
  orgId: string,
  taskId: string,
  status: CloseTaskStatus,
  options: { actor?: string; completedBy?: string } = {},
): Promise<CloseTask> {
  const actor = options.actor ?? "system";
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(closeTasksTable)
      .where(
        and(
          eq(closeTasksTable.orgId, orgId),
          eq(closeTasksTable.id, taskId),
        ),
      )
      .limit(1);
    if (!existing) throw new NotFoundError(`Close task ${taskId} not found.`);

    const [row] = await tx
      .update(closeTasksTable)
      .set({
        status,
        completedAt: status === "done" ? new Date() : null,
        completedBy: status === "done" ? options.completedBy : null,
      })
      .where(eq(closeTasksTable.id, taskId))
      .returning();

    await tx.insert(auditLogTable).values({
      orgId,
      actor,
      action: "close.task.status",
      entity: "close_task",
      entityId: row.id,
      before: serializeForAudit(existing),
      after: serializeForAudit(row),
    });

    return row;
  });
}

/**
 * Create a "prepared by client" request against a close period. Audit-logged.
 */
export async function createPbcRequest(
  orgId: string,
  periodId: string,
  title: string,
  options: { actor?: string; detail?: string; requestedBy?: string } = {},
): Promise<PbcRequest> {
  const actor = options.actor ?? "system";
  return db.transaction(async (tx) => {
    await loadPeriod(orgId, periodId);
    const [row] = await tx
      .insert(pbcRequestsTable)
      .values({
        orgId,
        periodId,
        title,
        detail: options.detail,
        requestedBy: options.requestedBy,
      })
      .returning();

    await tx.insert(auditLogTable).values({
      orgId,
      actor,
      action: "close.pbc.request",
      entity: "pbc_request",
      entityId: row.id,
      before: null,
      after: serializeForAudit(row),
    });

    return row;
  });
}

/**
 * The client responds to a PBC request, moving it to "provided". This is the
 * client-facing side of the close: the client supplies what the practice asked.
 */
export async function respondPbcRequest(
  orgId: string,
  requestId: string,
  response: string,
  options: { actor?: string } = {},
): Promise<PbcRequest> {
  const actor = options.actor ?? "client";
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(pbcRequestsTable)
      .where(
        and(
          eq(pbcRequestsTable.orgId, orgId),
          eq(pbcRequestsTable.id, requestId),
        ),
      )
      .limit(1);
    if (!existing) throw new NotFoundError(`PBC request ${requestId} not found.`);

    const [row] = await tx
      .update(pbcRequestsTable)
      .set({ status: "provided", response, respondedAt: new Date() })
      .where(eq(pbcRequestsTable.id, requestId))
      .returning();

    await tx.insert(auditLogTable).values({
      orgId,
      actor,
      action: "close.pbc.respond",
      entity: "pbc_request",
      entityId: row.id,
      before: serializeForAudit(existing),
      after: serializeForAudit(row),
    });

    return row;
  });
}

/** The practice accepts a provided PBC request, closing it out. Audit-logged. */
export async function acceptPbcRequest(
  orgId: string,
  requestId: string,
  options: { actor?: string } = {},
): Promise<PbcRequest> {
  const actor = options.actor ?? "system";
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(pbcRequestsTable)
      .where(
        and(
          eq(pbcRequestsTable.orgId, orgId),
          eq(pbcRequestsTable.id, requestId),
        ),
      )
      .limit(1);
    if (!existing) throw new NotFoundError(`PBC request ${requestId} not found.`);

    const [row] = await tx
      .update(pbcRequestsTable)
      .set({ status: "accepted" })
      .where(eq(pbcRequestsTable.id, requestId))
      .returning();

    await tx.insert(auditLogTable).values({
      orgId,
      actor,
      action: "close.pbc.accept",
      entity: "pbc_request",
      entityId: row.id,
      before: serializeForAudit(existing),
      after: serializeForAudit(row),
    });

    return row;
  });
}

/** List a client's close periods, newest period label first. */
export async function listClosePeriods(
  orgId: string,
): Promise<ClosePeriod[]> {
  return db
    .select()
    .from(closePeriodsTable)
    .where(eq(closePeriodsTable.orgId, orgId))
    .orderBy(closePeriodsTable.period);
}

export interface CloseStatusSummary {
  period: ClosePeriod;
  tasks: {
    total: number;
    done: number;
    inProgress: number;
    pending: number;
    /** done / total, 0..1 (1 when there are no tasks). */
    progress: number;
    items: CloseTask[];
  };
  pbc: {
    total: number;
    requested: number;
    provided: number;
    accepted: number;
    /** Requests still awaiting a client response or practice acceptance. */
    open: number;
    items: PbcRequest[];
  };
}

/**
 * Derive the full status of one close period: checklist progress and PBC
 * request state. Progress is computed from the tasks, never stored separately.
 */
export async function getCloseStatus(
  orgId: string,
  periodId: string,
): Promise<CloseStatusSummary> {
  const period = await loadPeriod(orgId, periodId);

  const tasks = await db
    .select()
    .from(closeTasksTable)
    .where(
      and(
        eq(closeTasksTable.orgId, orgId),
        eq(closeTasksTable.periodId, periodId),
      ),
    )
    .orderBy(asc(closeTasksTable.sortOrder), asc(closeTasksTable.createdAt));

  const pbc = await db
    .select()
    .from(pbcRequestsTable)
    .where(
      and(
        eq(pbcRequestsTable.orgId, orgId),
        eq(pbcRequestsTable.periodId, periodId),
      ),
    )
    .orderBy(asc(pbcRequestsTable.createdAt));

  const done = tasks.filter((t) => t.status === "done").length;
  const inProgress = tasks.filter((t) => t.status === "in_progress").length;
  const pending = tasks.filter((t) => t.status === "pending").length;

  const requested = pbc.filter((p) => p.status === "requested").length;
  const provided = pbc.filter((p) => p.status === "provided").length;
  const accepted = pbc.filter((p) => p.status === "accepted").length;

  return {
    period,
    tasks: {
      total: tasks.length,
      done,
      inProgress,
      pending,
      progress: tasks.length === 0 ? 1 : done / tasks.length,
      items: tasks,
    },
    pbc: {
      total: pbc.length,
      requested,
      provided,
      accepted,
      open: requested + provided,
      items: pbc,
    },
  };
}

/**
 * The latest close period for a client plus a compact progress view, for the
 * practice dashboard. Returns null when the client has no close periods yet.
 */
export async function getLatestCloseSummary(
  orgId: string,
): Promise<CloseStatusSummary | null> {
  const periods = await listClosePeriods(orgId);
  if (periods.length === 0) return null;
  const latest = periods[periods.length - 1];
  return getCloseStatus(orgId, latest.id);
}
