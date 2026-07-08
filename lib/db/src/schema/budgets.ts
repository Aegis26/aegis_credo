import {
  pgTable,
  uuid,
  text,
  date,
  bigint,
  timestamp,
  unique,
  foreignKey,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";
import { accountsTable } from "./accounts";

// A budget covers a period window. Actuals are always derived from the ledger
// (posted journal lines within the window) — a budget stores only planned
// figures, never actuals.
export const budgetsTable = pgTable(
  "budgets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    name: text("name").notNull(),
    periodStart: date("period_start", { mode: "string" }).notNull(),
    periodEnd: date("period_end", { mode: "string" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique("budgets_org_id_unique").on(t.orgId, t.id)],
);

export const insertBudgetSchema = createInsertSchema(budgetsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertBudget = z.infer<typeof insertBudgetSchema>;
export type Budget = typeof budgetsTable.$inferSelect;

// One planned amount per account within a budget.
export const budgetLinesTable = pgTable(
  "budget_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    budgetId: uuid("budget_id").notNull(),
    accountId: uuid("account_id").notNull(),
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("budget_lines_org_budget_account_unique").on(
      t.orgId,
      t.budgetId,
      t.accountId,
    ),
    foreignKey({
      name: "budget_lines_org_budget_fk",
      columns: [t.orgId, t.budgetId],
      foreignColumns: [budgetsTable.orgId, budgetsTable.id],
    }),
    foreignKey({
      name: "budget_lines_org_account_fk",
      columns: [t.orgId, t.accountId],
      foreignColumns: [accountsTable.orgId, accountsTable.id],
    }),
  ],
);

export const insertBudgetLineSchema = createInsertSchema(budgetLinesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertBudgetLine = z.infer<typeof insertBudgetLineSchema>;
export type BudgetLine = typeof budgetLinesTable.$inferSelect;
