import { and, eq, desc } from "drizzle-orm";
import {
  db,
  approvalRulesTable,
  approvalsTable,
  auditLogTable,
  type ApprovalRule,
  type Approval,
  type ApprovalStatus,
} from "@workspace/db";
import { assertPositiveMoney, type Money } from "./money";
import { ApprovalRequiredError, NotFoundError } from "./errors";
import { serializeForAudit } from "./audit";
import type { LedgerTx } from "./posting";

type Runner = LedgerTx | typeof db;

/**
 * Create an approval rule: entities of `entityType` whose amount is at or above
 * `threshold` require sign-off. Rules are org-scoped and audit-logged.
 */
export async function createApprovalRule(
  orgId: string,
  input: { entityType: string; threshold: Money; active?: boolean },
  options: { actor?: string } = {},
): Promise<ApprovalRule> {
  const threshold = assertPositiveMoney(input.threshold, "rule.threshold");
  const actor = options.actor ?? "system";
  return db.transaction(async (tx) => {
    const [rule] = await tx
      .insert(approvalRulesTable)
      .values({
        orgId,
        entityType: input.entityType,
        threshold,
        active: input.active ?? true,
      })
      .returning();

    await tx.insert(auditLogTable).values({
      orgId,
      actor,
      action: "approval.rule.create",
      entity: "approval_rule",
      entityId: rule.id,
      before: null,
      after: serializeForAudit(rule),
    });

    return rule;
  });
}

/** The active rule (if any) that governs an entity type at a given amount. */
async function matchingRule(
  runner: Runner,
  orgId: string,
  entityType: string,
  amount: Money,
): Promise<ApprovalRule | undefined> {
  const rules = await runner
    .select()
    .from(approvalRulesTable)
    .where(
      and(
        eq(approvalRulesTable.orgId, orgId),
        eq(approvalRulesTable.entityType, entityType),
        eq(approvalRulesTable.active, true),
      ),
    );
  // Trigger on the lowest threshold the amount meets or exceeds.
  return rules
    .filter((r) => amount >= r.threshold)
    .sort((a, b) => (a.threshold < b.threshold ? -1 : 1))[0];
}

/** Fetch the approval row for an entity, if one exists. */
export async function getApproval(
  orgId: string,
  entityType: string,
  entityId: string,
  runner: Runner = db,
): Promise<Approval | undefined> {
  const [row] = await runner
    .select()
    .from(approvalsTable)
    .where(
      and(
        eq(approvalsTable.orgId, orgId),
        eq(approvalsTable.entityType, entityType),
        eq(approvalsTable.entityId, entityId),
      ),
    )
    .limit(1);
  return row;
}

export interface ApprovalEvaluation {
  /** True when a rule requires sign-off for this entity. */
  required: boolean;
  /** The pending/decided approval row, when a rule applies. */
  approval?: Approval;
}

/**
 * Evaluate approval rules for an entity. If a rule requires sign-off, create (or
 * return the existing) pending approval row. Idempotent per
 * (org, entityType, entityId). Runs inside the caller's tx when provided so it
 * commits atomically with the entity being created.
 */
export async function evaluateApproval(
  orgId: string,
  entityType: string,
  entityId: string,
  amount: Money,
  options: { actor?: string; requestedBy?: string; tx?: LedgerTx } = {},
): Promise<ApprovalEvaluation> {
  const value = assertPositiveMoney(amount, "approval.amount");
  const actor = options.actor ?? "system";

  const run = async (tx: LedgerTx): Promise<ApprovalEvaluation> => {
    const existing = await getApproval(orgId, entityType, entityId, tx);
    if (existing) return { required: true, approval: existing };

    const rule = await matchingRule(tx, orgId, entityType, value);
    if (!rule) return { required: false };

    const inserted = await tx
      .insert(approvalsTable)
      .values({
        orgId,
        entityType,
        entityId,
        ruleId: rule.id,
        amount: value,
        status: "pending",
        requestedBy: options.requestedBy,
      })
      .onConflictDoNothing({
        target: [
          approvalsTable.orgId,
          approvalsTable.entityType,
          approvalsTable.entityId,
        ],
      })
      .returning();

    const approval =
      inserted[0] ?? (await getApproval(orgId, entityType, entityId, tx));
    if (!approval) throw new Error("Failed to create approval request.");

    if (inserted[0]) {
      await tx.insert(auditLogTable).values({
        orgId,
        actor,
        action: "approval.request",
        entity: "approval",
        entityId: approval.id,
        before: null,
        after: serializeForAudit(approval),
      });
    }

    return { required: true, approval };
  };

  return options.tx ? run(options.tx) : db.transaction(run);
}

/** Approve or reject a pending approval. Audit-logged. */
export async function decideApproval(
  orgId: string,
  approvalId: string,
  decision: Extract<ApprovalStatus, "approved" | "rejected">,
  options: { actor?: string; decidedBy?: string; note?: string } = {},
): Promise<Approval> {
  const actor = options.actor ?? "system";
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(approvalsTable)
      .where(
        and(
          eq(approvalsTable.orgId, orgId),
          eq(approvalsTable.id, approvalId),
        ),
      )
      .limit(1);
    if (!existing) {
      throw new NotFoundError(`Approval ${approvalId} not found for org.`);
    }

    const [updated] = await tx
      .update(approvalsTable)
      .set({
        status: decision,
        decidedBy: options.decidedBy,
        decidedAt: new Date(),
        note: options.note,
      })
      .where(eq(approvalsTable.id, approvalId))
      .returning();

    await tx.insert(auditLogTable).values({
      orgId,
      actor,
      action: `approval.${decision}`,
      entity: "approval",
      entityId: updated.id,
      before: serializeForAudit(existing),
      after: serializeForAudit(updated),
    });

    return updated;
  });
}

/**
 * True when an entity is clear to proceed: either no approval was ever required,
 * or its approval has been granted.
 */
export async function isApproved(
  orgId: string,
  entityType: string,
  entityId: string,
  runner: Runner = db,
): Promise<boolean> {
  const approval = await getApproval(orgId, entityType, entityId, runner);
  return !approval || approval.status === "approved";
}

/**
 * Gate an action on approval: throws ApprovalRequiredError when a rule created a
 * pending/rejected approval that has not been granted. Passes silently when no
 * rule applied. Callers (e.g. payBill) invoke this before moving money.
 */
export async function requireApproved(
  orgId: string,
  entityType: string,
  entityId: string,
  runner: Runner = db,
): Promise<void> {
  const approval = await getApproval(orgId, entityType, entityId, runner);
  if (approval && approval.status !== "approved") {
    throw new ApprovalRequiredError(
      `${entityType} ${entityId} requires approval (status: ${approval.status}).`,
    );
  }
}

/** List approvals for an org, newest first. */
export async function listApprovals(
  orgId: string,
  filter: { entityType?: string; status?: ApprovalStatus } = {},
): Promise<Approval[]> {
  const conds = [eq(approvalsTable.orgId, orgId)];
  if (filter.entityType) {
    conds.push(eq(approvalsTable.entityType, filter.entityType));
  }
  if (filter.status) conds.push(eq(approvalsTable.status, filter.status));
  return db
    .select()
    .from(approvalsTable)
    .where(and(...conds))
    .orderBy(desc(approvalsTable.createdAt));
}
