import {
  pgTable,
  uuid,
  text,
  bigint,
  boolean,
  timestamp,
  pgEnum,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";
import { usersTable } from "./users";

// Configurable approval rules: e.g. bills at or above a threshold require
// sign-off before they can be paid. Rules are org-scoped and keyed by the type
// of entity they govern (currently "bill").
export const approvalRulesTable = pgTable(
  "approval_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    entityType: text("entity_type").notNull(), // e.g. "bill"
    // Amounts at or above this threshold (integer minor units) require approval.
    threshold: bigint("threshold", { mode: "bigint" }).notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique("approval_rules_org_id_unique").on(t.id, t.orgId)],
);

export const insertApprovalRuleSchema = createInsertSchema(
  approvalRulesTable,
).omit({ id: true, createdAt: true });
export type InsertApprovalRule = z.infer<typeof insertApprovalRuleSchema>;
export type ApprovalRule = typeof approvalRulesTable.$inferSelect;

export const approvalStatusEnum = pgEnum("approval_status", [
  "pending",
  "approved",
  "rejected",
]);

// An approval request against a specific entity (e.g. a bill). Exactly one row
// per (org, entityType, entityId). The status transitions are audit-logged in
// audit_log; this row holds the current state and decision metadata.
export const approvalsTable = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    ruleId: uuid("rule_id").references(() => approvalRulesTable.id),
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    status: approvalStatusEnum("status").notNull().default("pending"),
    requestedBy: uuid("requested_by").references(() => usersTable.id),
    decidedBy: uuid("decided_by").references(() => usersTable.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("approvals_org_entity_unique").on(
      t.orgId,
      t.entityType,
      t.entityId,
    ),
  ],
);

export const insertApprovalSchema = createInsertSchema(approvalsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertApproval = z.infer<typeof insertApprovalSchema>;
export type Approval = typeof approvalsTable.$inferSelect;
export type ApprovalStatus = (typeof approvalStatusEnum.enumValues)[number];
