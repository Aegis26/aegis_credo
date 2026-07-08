import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, invoicesTable, invoicePaymentsTable } from "@workspace/db";
import {
  ListInvoicesParams,
  ListInvoicesResponse,
  CreateInvoiceParams,
  CreateInvoiceBody,
  CreateInvoiceResponse,
  SendInvoiceParams,
  SendInvoiceResponse,
  PayInvoiceParams,
  PayInvoiceBody,
  PayInvoiceResponse,
} from "@workspace/api-zod";
import {
  requirePermission,
  createInvoice,
  payInvoice,
  formatMoney,
  NotFoundError,
} from "@workspace/ledger";
import { sendLedgerError } from "../lib/errors";
import { getSessionUserId } from "../middlewares/auth";
import { parseMoney } from "../lib/money";
import { accountByCode } from "./orgs";

const router: IRouter = Router();

type InvoiceRow = typeof invoicesTable.$inferSelect;

function toInvoice(invoice: InvoiceRow, paid: bigint) {
  const outstanding = invoice.amount - paid;
  return {
    id: invoice.id,
    customer: invoice.customer,
    invoiceNumber: invoice.invoiceNumber,
    invoiceDate: invoice.invoiceDate,
    dueDate: invoice.dueDate,
    amount: formatMoney(invoice.amount),
    paid: formatMoney(paid),
    outstanding: formatMoney(outstanding < 0n ? 0n : outstanding),
    status: invoice.status,
    sentAt: invoice.sentAt ? invoice.sentAt.toISOString() : null,
  };
}

/** Sum recorded payments for a single invoice. */
async function paidForInvoice(orgId: string, invoiceId: string): Promise<bigint> {
  const [row] = await db
    .select({
      total: sql<string>`COALESCE(SUM(${invoicePaymentsTable.amount}), 0)`,
    })
    .from(invoicePaymentsTable)
    .where(
      and(
        eq(invoicePaymentsTable.orgId, orgId),
        eq(invoicePaymentsTable.invoiceId, invoiceId),
      ),
    );
  return BigInt(row?.total ?? "0");
}

router.get("/orgs/:orgId/invoices", async (req, res) => {
  try {
    const userId = getSessionUserId(req);
    const { orgId } = ListInvoicesParams.parse(req.params);
    await requirePermission(orgId, userId, "reports.read");

    const invoices = await db
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.orgId, orgId))
      .orderBy(desc(invoicesTable.createdAt));

    const paidByInvoice = new Map<string, bigint>();
    if (invoices.length > 0) {
      const ids = invoices.map((i) => i.id);
      const sums = await db
        .select({
          invoiceId: invoicePaymentsTable.invoiceId,
          total: sql<string>`COALESCE(SUM(${invoicePaymentsTable.amount}), 0)`,
        })
        .from(invoicePaymentsTable)
        .where(
          and(
            eq(invoicePaymentsTable.orgId, orgId),
            inArray(invoicePaymentsTable.invoiceId, ids),
          ),
        )
        .groupBy(invoicePaymentsTable.invoiceId);
      for (const s of sums) paidByInvoice.set(s.invoiceId, BigInt(s.total));
    }

    res.json(
      ListInvoicesResponse.parse({
        invoices: invoices.map((i) =>
          toInvoice(i, paidByInvoice.get(i.id) ?? 0n),
        ),
      }),
    );
  } catch (err) {
    sendLedgerError(res, err);
  }
});

router.post("/orgs/:orgId/invoices", async (req, res) => {
  try {
    const userId = getSessionUserId(req);
    const { orgId } = CreateInvoiceParams.parse(req.params);
    const body = CreateInvoiceBody.parse(req.body);
    await requirePermission(orgId, userId, "ledger.post");

    const ar = await accountByCode(orgId, "1100");
    const revenueAccountId =
      body.revenueAccountId ?? (await accountByCode(orgId, "4100")).id;

    const { invoice } = await createInvoice(
      orgId,
      {
        customer: body.customer,
        invoiceNumber: body.invoiceNumber ?? undefined,
        invoiceDate: body.invoiceDate,
        dueDate: body.dueDate,
        amount: parseMoney(body.amount, "invoice.amount"),
        arAccountId: ar.id,
        revenueAccountId,
      },
      { actor: userId },
    );

    res.status(201).json(CreateInvoiceResponse.parse(toInvoice(invoice, 0n)));
  } catch (err) {
    sendLedgerError(res, err);
  }
});

router.post("/orgs/:orgId/invoices/:invoiceId/send", async (req, res) => {
  try {
    const userId = getSessionUserId(req);
    const { orgId, invoiceId } = SendInvoiceParams.parse(req.params);
    await requirePermission(orgId, userId, "ledger.post");

    const [invoice] = await db
      .update(invoicesTable)
      .set({ sentAt: new Date() })
      .where(
        and(eq(invoicesTable.orgId, orgId), eq(invoicesTable.id, invoiceId)),
      )
      .returning();
    if (!invoice) throw new NotFoundError("Invoice not found for org.");

    const paid = await paidForInvoice(orgId, invoiceId);
    res.json(SendInvoiceResponse.parse(toInvoice(invoice, paid)));
  } catch (err) {
    sendLedgerError(res, err);
  }
});

router.post("/orgs/:orgId/invoices/:invoiceId/pay", async (req, res) => {
  try {
    const userId = getSessionUserId(req);
    const { orgId, invoiceId } = PayInvoiceParams.parse(req.params);
    const body = PayInvoiceBody.parse(req.body);
    await requirePermission(orgId, userId, "ledger.post");

    const cashAccountId =
      body.cashAccountId ?? (await accountByCode(orgId, "1000")).id;

    const { invoice } = await payInvoice(
      orgId,
      {
        invoiceId,
        paymentDate: body.paymentDate,
        amount: parseMoney(body.amount, "payment.amount"),
        cashAccountId,
      },
      { actor: userId },
    );

    const paid = await paidForInvoice(orgId, invoiceId);
    res.json(PayInvoiceResponse.parse(toInvoice(invoice, paid)));
  } catch (err) {
    sendLedgerError(res, err);
  }
});

export default router;
