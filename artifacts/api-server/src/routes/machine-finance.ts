import { Router, type IRouter, type Request } from "express";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  invoicesTable,
  invoicePaymentsTable,
  journalEntriesTable,
  journalLinesTable,
} from "@workspace/db";
import {
  createInvoice,
  formatMoney,
  getTrialBalance,
  postJournalEntry,
} from "@workspace/ledger";
import {
  CreateIntegrationInvoiceBody,
  ListIntegrationInvoicesResponse,
  CreateIntegrationInvoiceResponse,
  ListIntegrationGlEntriesResponse,
  CreateIntegrationGlEntryResponse,
  GetIntegrationTrialBalanceResponse,
  GetIntegrationReportsResponse,
  ListIntegrationCustomersResponse,
} from "@workspace/api-zod";
import { accountByCode } from "./orgs";
import { parseMoney } from "../lib/money";
import { ConflictError, HttpError, sendLedgerError } from "../lib/errors";
import type {
  MachinePrincipal as AuthenticatedMachinePrincipal,
  MachineScope,
} from "../lib/machine-credentials";

/** The machine-auth middleware is intentionally supplied by the host router. */
export type MachinePrincipal = AuthenticatedMachinePrincipal;
type MachineRequest = Request & { machine?: MachinePrincipal };

const params = z.object({ orgId: z.string().uuid() });
const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
const glBody = z.object({
  entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  memo: z.string().optional(),
  idempotencyKey: z.string().min(1),
  lines: z.array(
    z.object({
      accountId: z.string().uuid(),
      debit: z.string().optional(),
      credit: z.string().optional(),
      memo: z.string().optional(),
      classId: z.string().uuid().optional(),
      departmentId: z.string().uuid().optional(),
      locationId: z.string().uuid().optional(),
      counterpartyOrgId: z.string().uuid().optional(),
    }),
  ).min(2),
});

function principal(req: MachineRequest, orgId: string, scope: MachineScope): MachinePrincipal {
  const machine = req.machine;
  if (!machine) throw new HttpError(403, "Machine authorization required.");
  if (machine.orgId !== orgId) throw new HttpError(403, "Machine is not authorized for this org.");
  if (!machine.scopes.includes(scope)) throw new HttpError(403, "Machine lacks the required scope.");
  return machine;
}

function invoiceOutput(invoice: typeof invoicesTable.$inferSelect, paid: bigint) {
  const outstanding = invoice.amount > paid ? invoice.amount - paid : 0n;
  return {
    id: invoice.id,
    customer: invoice.customer,
    invoiceNumber: invoice.invoiceNumber,
    invoiceDate: invoice.invoiceDate,
    dueDate: invoice.dueDate,
    amount: formatMoney(invoice.amount),
    paid: formatMoney(paid),
    outstanding: formatMoney(outstanding),
    status: invoice.status,
    sentAt: invoice.sentAt?.toISOString() ?? null,
  };
}

const router: IRouter = Router();

router.get("/integrations/orgs/:orgId/invoices", async (req, res) => {
  try {
    const { orgId } = params.parse(req.params);
     principal(req as MachineRequest, orgId, "read:invoices");
    const { limit, offset } = pagination.parse(req.query);
    const rows = await db.select().from(invoicesTable)
      .where(eq(invoicesTable.orgId, orgId))
      .orderBy(desc(invoicesTable.createdAt)).limit(limit).offset(offset);
    const paidRows = rows.length ? await db.select({
      invoiceId: invoicePaymentsTable.invoiceId,
      total: sql<string>`coalesce(sum(${invoicePaymentsTable.amount}), 0)`,
    }).from(invoicePaymentsTable).where(and(
      eq(invoicePaymentsTable.orgId, orgId),
      inArray(invoicePaymentsTable.invoiceId, rows.map((row) => row.id)),
    )).groupBy(invoicePaymentsTable.invoiceId) : [];
    const paidByInvoice = new Map(paidRows.map((row) => [row.invoiceId, BigInt(row.total)]));
    res.json(ListIntegrationInvoicesResponse.parse({
      invoices: rows.map((row) => invoiceOutput(row, paidByInvoice.get(row.id) ?? 0n)),
    }));
  } catch (err) { sendLedgerError(res, err); }
});

router.post("/integrations/orgs/:orgId/invoices", async (req, res) => {
  try {
    const { orgId } = params.parse(req.params);
    const machine = principal(req as MachineRequest, orgId, "write:invoices");
    const body = CreateIntegrationInvoiceBody.parse(req.body);
    const invoiceDate = body.invoiceDate.toISOString().slice(0, 10);
    const dueDate = body.dueDate.toISOString().slice(0, 10);
    const ar = body.arAccountId ? { id: body.arAccountId } : await accountByCode(orgId, "1100");
    const revenue = body.revenueAccountId
      ? { id: body.revenueAccountId }
      : await accountByCode(orgId, "4100");
    const externalId = `machine:${machine.credentialId}:${body.idempotencyKey}`;
    const result = await createInvoice(orgId, {
      customer: body.customer,
      invoiceNumber: body.invoiceNumber,
      invoiceDate,
      dueDate,
      amount: parseMoney(body.amount, "amount"),
      arAccountId: ar.id,
      revenueAccountId: revenue.id,
      externalId,
    }, { actor: machine.credentialId });
    if (result.invoice.customer !== body.customer ||
      result.invoice.invoiceNumber !== (body.invoiceNumber ?? null) ||
      result.invoice.invoiceDate !== invoiceDate ||
      result.invoice.dueDate !== dueDate ||
      result.invoice.amount !== parseMoney(body.amount, "amount") ||
      result.invoice.revenueAccountId !== revenue.id ||
      result.invoice.arAccountId !== ar.id) {
      throw new ConflictError("The idempotency key is already used for a different invoice.");
    }
    res.status(201).json(CreateIntegrationInvoiceResponse.parse(invoiceOutput(result.invoice, 0n)));
  } catch (err) { sendLedgerError(res, err); }
});

router.get("/integrations/orgs/:orgId/gl-entries", async (req, res) => {
  try {
    const { orgId } = params.parse(req.params);
    principal(req as MachineRequest, orgId, "read:gl");
    const { limit, offset } = pagination.parse(req.query);
    const entries = await db.select().from(journalEntriesTable)
      .where(eq(journalEntriesTable.orgId, orgId))
      .orderBy(desc(journalEntriesTable.postedAt)).limit(limit).offset(offset);
    const lines = entries.length ? await db.select().from(journalLinesTable)
      .where(and(eq(journalLinesTable.orgId, orgId), inArray(journalLinesTable.entryId, entries.map((e) => e.id))))
      : [];
    const byEntry = new Map<string, typeof lines>();
    for (const line of lines) byEntry.set(line.entryId, [...(byEntry.get(line.entryId) ?? []), line]);
    res.json(ListIntegrationGlEntriesResponse.parse({ entries: entries.map((entry) => ({
      id: entry.id, entryDate: entry.entryDate, memo: entry.memo,
      source: entry.source, postedAt: entry.postedAt,
      lines: (byEntry.get(entry.id) ?? []).map((line) => ({
        id: line.id, accountId: line.accountId, debit: formatMoney(line.debit),
        credit: formatMoney(line.credit), memo: line.memo,
      })),
    })) }));
  } catch (err) { sendLedgerError(res, err); }
});

router.post("/integrations/orgs/:orgId/gl-entries", async (req, res) => {
  try {
    const { orgId } = params.parse(req.params);
    const machine = principal(req as MachineRequest, orgId, "write:gl");
    const body = glBody.parse(req.body);
    const scopedKey = `machine:${machine.credentialId}:${body.idempotencyKey}`;
    const parsedLines = body.lines.map((line) => ({
      ...line,
      debit: line.debit === undefined ? undefined : parseMoney(line.debit, "debit"),
      credit: line.credit === undefined ? undefined : parseMoney(line.credit, "credit"),
    }));
    const posted = await postJournalEntry(orgId, {
      entryDate: body.entryDate, memo: body.memo, source: "machine_integration",
      lines: parsedLines,
    }, { idempotencyKey: scopedKey, actor: machine.credentialId });
    // A retry must refer to the same economic event, including dimensions.
    // Compare as a multiset because SQL does not guarantee row order on reads.
    const lineSignature = (line: {
      accountId: string; debit?: bigint | null; credit?: bigint | null;
      memo?: string | null; classId?: string | null; departmentId?: string | null;
      locationId?: string | null; counterpartyOrgId?: string | null;
    }) => JSON.stringify([
      line.accountId, String(line.debit ?? 0n), String(line.credit ?? 0n),
      line.memo ?? null, line.classId ?? null, line.departmentId ?? null,
      line.locationId ?? null, line.counterpartyOrgId ?? null,
    ]);
    const storedLines = posted.lines.map(lineSignature).sort();
    const requestedLines = parsedLines.map(lineSignature).sort();
    const sameRequest = posted.entry.entryDate === body.entryDate &&
      posted.entry.memo === (body.memo ?? null) &&
      posted.entry.source === "machine_integration" &&
      storedLines.length === requestedLines.length &&
      storedLines.every((line, index) => line === requestedLines[index]);
    if (!sameRequest) {
      throw new ConflictError("The idempotency key is already used for a different journal entry.");
    }
    res.status(201).json(CreateIntegrationGlEntryResponse.parse({ id: posted.entry.id,
      entryDate: posted.entry.entryDate, memo: posted.entry.memo,
      source: posted.entry.source, postedAt: posted.entry.postedAt,
      lines: posted.lines.map((line) => ({ id: line.id, accountId: line.accountId,
        debit: formatMoney(line.debit), credit: formatMoney(line.credit), memo: line.memo })) }));
  } catch (err) { sendLedgerError(res, err); }
});

router.get("/integrations/orgs/:orgId/reports/trial-balance", async (req, res) => {
  try {
    const { orgId } = params.parse(req.params);
    principal(req as MachineRequest, orgId, "read:reports");
    const trial = await getTrialBalance(orgId);
    res.json(GetIntegrationTrialBalanceResponse.parse({ rows: trial.rows.map((row) => ({ accountId: row.accountId, code: row.code,
      name: row.name, type: row.type, debit: formatMoney(row.debit), credit: formatMoney(row.credit) })),
      totalDebit: formatMoney(trial.totalDebit), totalCredit: formatMoney(trial.totalCredit),
      difference: formatMoney(trial.difference), balanced: trial.difference === 0n }));
  } catch (err) { sendLedgerError(res, err); }
});

router.get("/integrations/orgs/:orgId/reports", async (req, res) => {
  try {
    const { orgId } = params.parse(req.params);
    principal(req as MachineRequest, orgId, "read:reports");
    const trial = await getTrialBalance(orgId);
    const toTrialRow = (row: (typeof trial.rows)[number]) => ({
      accountId: row.accountId,
      code: row.code,
      name: row.name,
      type: row.type,
      debit: formatMoney(row.debit),
      credit: formatMoney(row.credit),
    });
    const revenue = trial.rows.filter((row) => row.type === "revenue");
    const expenses = trial.rows.filter((row) => row.type === "expense");
    const totalRevenue = revenue.reduce((sum, row) => sum + row.balance, 0n);
    const totalExpenses = expenses.reduce((sum, row) => sum + row.balance, 0n);
    const toAmountRow = (row: (typeof trial.rows)[number]) => ({
      accountId: row.accountId,
      code: row.code,
      name: row.name,
      amount: formatMoney(row.balance),
    });
    const byType = (type: string) => trial.rows.filter((row) => row.type === type);
    const assets = byType("asset");
    const liabilities = byType("liability");
    const equity = byType("equity");
    const sum = (rows: typeof trial.rows) =>
      rows.reduce((total, row) => total + row.balance, 0n);
    const totalAssets = sum(assets);
    const totalLiabilities = sum(liabilities);
    const totalEquity = sum(equity);
    const netIncome = sum(revenue) - sum(expenses);
    const equityWithIncome = totalEquity + netIncome;

    res.json(GetIntegrationReportsResponse.parse({
      trialBalance: {
        rows: trial.rows.map(toTrialRow),
        totalDebit: formatMoney(trial.totalDebit),
        totalCredit: formatMoney(trial.totalCredit),
        difference: formatMoney(trial.difference),
        balanced: trial.difference === 0n,
      },
      profitAndLoss: {
        revenue: revenue.filter((row) => row.balance !== 0n).map(toAmountRow),
        expenses: expenses.filter((row) => row.balance !== 0n).map(toAmountRow),
        totalRevenue: formatMoney(totalRevenue),
        totalExpenses: formatMoney(totalExpenses),
        netIncome: formatMoney(totalRevenue - totalExpenses),
      },
      balanceSheet: {
        assets: assets.filter((row) => row.balance !== 0n).map(toAmountRow),
        liabilities: liabilities.filter((row) => row.balance !== 0n).map(toAmountRow),
        equity: equity.filter((row) => row.balance !== 0n).map(toAmountRow),
        totalAssets: formatMoney(totalAssets),
        totalLiabilities: formatMoney(totalLiabilities),
        totalEquity: formatMoney(totalEquity),
        netIncome: formatMoney(netIncome),
        equityWithIncome: formatMoney(equityWithIncome),
        totalLiabilitiesAndEquity: formatMoney(totalLiabilities + equityWithIncome),
        balanced: totalAssets === totalLiabilities + equityWithIncome,
      },
    }));
  } catch (err) { sendLedgerError(res, err); }
});

router.get("/integrations/orgs/:orgId/customers", async (req, res) => {
  try {
    const { orgId } = params.parse(req.params);
    principal(req as MachineRequest, orgId, "read:customers");
    const rows = await db.select({ name: invoicesTable.customer }).from(invoicesTable)
      .where(eq(invoicesTable.orgId, orgId)).groupBy(invoicesTable.customer)
      .orderBy(asc(invoicesTable.customer));
    res.json(ListIntegrationCustomersResponse.parse({ customers: rows.map((row) => ({ name: row.name })) }));
  } catch (err) { sendLedgerError(res, err); }
});

export default router;
export { router };