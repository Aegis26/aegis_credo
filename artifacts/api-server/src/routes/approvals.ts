import { Router, type IRouter } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db, auditLogTable, approvalRulesTable } from "@workspace/db";
import {
  ListOrgApprovalsParams,
  ListOrgApprovalsQueryParams,
  ListOrgApprovalsResponse,
  DecideOrgApprovalParams,
  DecideOrgApprovalBody,
  DecideOrgApprovalResponse,
  GetApprovalAuditParams,
  GetApprovalAuditResponse,
  ListApprovalRulesParams,
  ListApprovalRulesResponse,
  CreateOrgApprovalRuleParams,
  CreateOrgApprovalRuleBody,
  CreateOrgApprovalRuleResponse,
} from "@workspace/api-zod";
import {
  listApprovals,
  decideApproval,
  createApprovalRule,
  requirePermission,
  formatMoney,
  parseDecimalToMinor,
} from "@workspace/ledger";
import type { Approval } from "@workspace/db";
import { sendLedgerError } from "../lib/errors";
import { getSessionUserId } from "../middlewares/auth";

const router: IRouter = Router();

function serializeApproval(a: Approval) {
  return {
    id: a.id,
    entityType: a.entityType,
    entityId: a.entityId,
    amount: formatMoney(a.amount),
    status: a.status,
    note: a.note ?? null,
    requestedBy: a.requestedBy ?? null,
    decidedBy: a.decidedBy ?? null,
    decidedAt: a.decidedAt ? a.decidedAt.toISOString() : null,
    createdAt: a.createdAt.toISOString(),
  };
}

router.get("/orgs/:orgId/approvals", async (req, res) => {
  try {
    const { orgId } = ListOrgApprovalsParams.parse(req.params);
    const { status } = ListOrgApprovalsQueryParams.parse(req.query);
    const userId = getSessionUserId(req);
    await requirePermission(orgId, userId, "reports.read");
    const approvals = await listApprovals(orgId, status ? { status } : {});
    res.json(
      ListOrgApprovalsResponse.parse({
        approvals: approvals.map(serializeApproval),
      }),
    );
  } catch (err) {
    sendLedgerError(res, err);
  }
});

router.post("/orgs/:orgId/approvals/:approvalId/decide", async (req, res) => {
  try {
    const { orgId, approvalId } = DecideOrgApprovalParams.parse(req.params);
    const userId = getSessionUserId(req);
    // Sign-off is an owner-level act.
    await requirePermission(orgId, userId, "members.manage");
    const body = DecideOrgApprovalBody.parse(req.body);
    const approval = await decideApproval(orgId, approvalId, body.decision, {
      actor: userId,
      decidedBy: userId,
      note: body.note,
    });
    res.json(DecideOrgApprovalResponse.parse(serializeApproval(approval)));
  } catch (err) {
    sendLedgerError(res, err);
  }
});

router.get("/orgs/:orgId/approvals/audit", async (req, res) => {
  try {
    const { orgId } = GetApprovalAuditParams.parse(req.params);
    const userId = getSessionUserId(req);
    await requirePermission(orgId, userId, "reports.read");
    const events = await db
      .select()
      .from(auditLogTable)
      .where(
        and(
          eq(auditLogTable.orgId, orgId),
          inArray(auditLogTable.entity, ["approval", "approval_rule"]),
        ),
      )
      .orderBy(desc(auditLogTable.createdAt))
      .limit(200);
    res.json(
      GetApprovalAuditResponse.parse({
        events: events.map((e) => ({
          id: e.id,
          actor: e.actor,
          action: e.action,
          entity: e.entity,
          entityId: e.entityId,
          createdAt: e.createdAt.toISOString(),
        })),
      }),
    );
  } catch (err) {
    sendLedgerError(res, err);
  }
});

router.get("/orgs/:orgId/approval-rules", async (req, res) => {
  try {
    const { orgId } = ListApprovalRulesParams.parse(req.params);
    const userId = getSessionUserId(req);
    await requirePermission(orgId, userId, "reports.read");
    const rules = await db
      .select()
      .from(approvalRulesTable)
      .where(eq(approvalRulesTable.orgId, orgId))
      .orderBy(desc(approvalRulesTable.createdAt));
    res.json(
      ListApprovalRulesResponse.parse({
        rules: rules.map((r) => ({
          id: r.id,
          entityType: r.entityType,
          threshold: formatMoney(r.threshold),
          active: r.active,
          createdAt: r.createdAt.toISOString(),
        })),
      }),
    );
  } catch (err) {
    sendLedgerError(res, err);
  }
});

router.post("/orgs/:orgId/approval-rules", async (req, res) => {
  try {
    const { orgId } = CreateOrgApprovalRuleParams.parse(req.params);
    const userId = getSessionUserId(req);
    await requirePermission(orgId, userId, "members.manage");
    const body = CreateOrgApprovalRuleBody.parse(req.body);
    const rule = await createApprovalRule(
      orgId,
      {
        entityType: body.entityType,
        threshold: parseDecimalToMinor(body.threshold, "rule.threshold"),
        active: body.active,
      },
      { actor: userId },
    );
    res.status(201).json(
      CreateOrgApprovalRuleResponse.parse({
        id: rule.id,
        entityType: rule.entityType,
        threshold: formatMoney(rule.threshold),
        active: rule.active,
        createdAt: rule.createdAt.toISOString(),
      }),
    );
  } catch (err) {
    sendLedgerError(res, err);
  }
});

export default router;
