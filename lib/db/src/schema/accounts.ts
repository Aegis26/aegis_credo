import {
  pgTable,
  uuid,
  text,
  timestamp,
  pgEnum,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";

export const accountTypeEnum = pgEnum("account_type", [
  "asset",
  "liability",
  "equity",
  "revenue",
  "expense",
]);

export const normalBalanceEnum = pgEnum("normal_balance", ["debit", "credit"]);

export const accountsTable = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    code: text("code").notNull(),
    name: text("name").notNull(),
    type: accountTypeEnum("type").notNull(),
    normalBalance: normalBalanceEnum("normal_balance").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("accounts_org_code_unique").on(t.orgId, t.code),
    // Enables composite (org_id, id) foreign keys from journal_lines so a line
    // can never reference an account belonging to another tenant.
    unique("accounts_org_id_unique").on(t.id, t.orgId),
  ],
);

export const insertAccountSchema = createInsertSchema(accountsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertAccount = z.infer<typeof insertAccountSchema>;
export type Account = typeof accountsTable.$inferSelect;
export type AccountType = (typeof accountTypeEnum.enumValues)[number];
export type NormalBalance = (typeof normalBalanceEnum.enumValues)[number];
