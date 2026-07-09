import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, billsTable, billPaymentsTable } from "@workspace/db";
import {
  ListBillsParams,
  ListBillsResponse,
  CreateBillParams,
  CreateBillBody,
  CreateBillResponse,
  PayBillParams,
  PayBillBody,
  PayBillResponse,
} from "@workspace/api-zod";
import {
  requirePermission,
  createBill as createBillEntry,
  payBill as payBillEntry,
  formatMoney,
} from "@workspace/ledger";
import { sendLedgerError } from "../lib/errors";
import { getSessionUserId } from "../middlewares/auth";
import { parseMoney } from "../lib/money";
import { accountByCode } from "./orgs";

const router: IRouter = Router();

type BillRow = typeof billsTable.$inferSelect;

function toBill(bill: BillRow, paid: bigint) {
  const outstanding = bill.amount - paid;
  return {
    id: bill.id,
    vendor: bill.vendor,
    billNumber: bill.billNumber,
    billDate: bill.billDate,
    dueDate: bill.dueDate,
    amount: formatMoney(bill.amount),
    paid: formatMoney(paid),
    outstanding: formatMoney(outstanding < 0n ? 0n : outstanding),
    status: bill.status,
  };
}

/** Sum recorded payments for a single bill. */
async function paidForBill(orgId: string, billId: string): Promise<bigint> {
  const [row] = await db
    .select({
      total: sql<string>`COALESCE(SUM(${billPaymentsTable.amount}), 0)`,
    })
    .from(billPaymentsTable)
    .where(
      and(
        eq(billPaymentsTable.orgId, orgId),
        eq(billPaymentsTable.billId, billId),
      ),
    );
  return BigInt(row?.total ?? "0");
}

router.get("/orgs/:orgId/bills", async (req, res) => {
  try {
    const userId = getSessionUserId(req);
    const { orgId } = ListBillsParams.parse(req.params);
    await requirePermission(orgId, userId, "reports.read");

    const bills = await db
      .select()
      .from(billsTable)
      .where(eq(billsTable.orgId, orgId))
      .orderBy(desc(billsTable.createdAt));

    const paidByBill = new Map<string, bigint>();
    if (bills.length > 0) {
      const ids = bills.map((b) => b.id);
      const sums = await db
        .select({
          billId: billPaymentsTable.billId,
          total: sql<string>`COALESCE(SUM(${billPaymentsTable.amount}), 0)`,
        })
        .from(billPaymentsTable)
        .where(
          and(
            eq(billPaymentsTable.orgId, orgId),
            inArray(billPaymentsTable.billId, ids),
          ),
        )
        .groupBy(billPaymentsTable.billId);
      for (const s of sums) paidByBill.set(s.billId, BigInt(s.total));
    }

    res.json(
      ListBillsResponse.parse({
        bills: bills.map((b) => toBill(b, paidByBill.get(b.id) ?? 0n)),
      }),
    );
  } catch (err) {
    sendLedgerError(res, err);
  }
});

router.post("/orgs/:orgId/bills", async (req, res) => {
  try {
    const userId = getSessionUserId(req);
    const { orgId } = CreateBillParams.parse(req.params);
    const body = CreateBillBody.parse(req.body);
    await requirePermission(orgId, userId, "ledger.post");

    const ap = await accountByCode(orgId, "2000");

    const { bill } = await createBillEntry(
      orgId,
      {
        vendor: body.vendor,
        billNumber: body.billNumber || undefined,
        billDate: body.billDate,
        dueDate: body.dueDate,
        amount: parseMoney(body.amount, "bill.amount"),
        apAccountId: ap.id,
        expenseAccountId: body.expenseAccountId,
      },
      { actor: userId },
    );

    res.status(201).json(CreateBillResponse.parse(toBill(bill, 0n)));
  } catch (err) {
    sendLedgerError(res, err);
  }
});

router.post("/orgs/:orgId/bills/:billId/pay", async (req, res) => {
  try {
    const userId = getSessionUserId(req);
    const { orgId, billId } = PayBillParams.parse(req.params);
    const body = PayBillBody.parse(req.body);
    await requirePermission(orgId, userId, "ledger.post");

    const cashAccountId =
      body.cashAccountId ?? (await accountByCode(orgId, "1000")).id;

    const { bill } = await payBillEntry(
      orgId,
      {
        billId,
        paymentDate: body.paymentDate,
        amount: parseMoney(body.amount, "payment.amount"),
        cashAccountId,
      },
      { actor: userId },
    );

    const paid = await paidForBill(orgId, billId);
    res.json(PayBillResponse.parse(toBill(bill, paid)));
  } catch (err) {
    sendLedgerError(res, err);
  }
});

export default router;
