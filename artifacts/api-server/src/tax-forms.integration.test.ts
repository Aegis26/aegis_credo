import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { sql } from "drizzle-orm";
import { db, bankTransactionsTable } from "@workspace/db";
import { createBill, payBill, addMember, postJournalEntry } from "@workspace/ledger";
import { createApp } from "./app";

const app = createApp({ apiRateLimitMax: 2000, authRateLimitMax: 2000 });
const owner = request.agent(app), outsider = request.agent(app);
const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const users: string[] = [], orgs: string[] = [];
let orgId: string, otherOrgId: string, paymentId: string, foreignAccountId: string;
let accountIds: Record<string, string>;
const reviewUrl = () => `/api/orgs/${orgId}/tax-forms/review`;
const pdfUrl = () => `/api/orgs/${orgId}/tax-forms/pdf`;

beforeAll(async () => {
  for (const [agent, suffix] of [[owner, "owner"], [outsider, "outsider"]] as const) {
    const r = await agent.post("/api/auth/signup").send({ email: `tax-draft-${suffix}-${nonce}@example.test`, password: "draft-review-test-password", name: `Draft test ${suffix}` });
    expect(r.status).toBe(201); users.push(r.body.user.id);
  }
  for (const suffix of ["A", "B"]) {
    const r = await owner.post("/api/orgs").send({ name: `Draft Test ${suffix} ${nonce}` });
    expect(r.status).toBe(201); orgs.push(r.body.id);
  }
  [orgId, otherOrgId] = orgs as [string, string];
  const a = await owner.get(`/api/orgs/${orgId}/accounts`);
  accountIds = Object.fromEntries(a.body.accounts.map((a: { code: string; id: string }) => [a.code, a.id]));
  const other = await owner.get(`/api/orgs/${otherOrgId}/accounts`);
  foreignAccountId = other.body.accounts.find((a: { type: string }) => a.type === "expense").id;
  const expenseAccountId = a.body.accounts.find((a: { type: string }) => a.type === "expense").id;
  const bill = await createBill(orgId, { vendor: "Draft Contractor Alpha", billDate: "2025-12-01", dueDate: "2025-12-15",
    amount: 1000000n, apAccountId: accountIds["2000"]!, expenseAccountId }, { actor: users[0] });
  for (const [date, amount] of [["2025-12-31", 65000n], ["2026-01-01", 200000n], ["2026-12-31", 50000n], ["2027-01-01", 7500n]] as const) {
    const p = await payBill(orgId, { billId: bill.bill.id, paymentDate: date, amount, cashAccountId: accountIds["1000"]! }, { actor: users[0] });
    if (date === "2026-01-01") {
      paymentId = p.payment.id;
      await db.insert(bankTransactionsTable).values({ orgId, txnDate: date, amount: -amount,
        cashAccountId: accountIds["1000"], matchedEntryId: p.posted.entry.id, description: "Same payment bank mirror" });
    }
  }
});

afterAll(async () => {
  if (orgs.length === 2) {
    const scope = sql`(${orgs[0]}, ${orgs[1]})`;
    for (const table of ["bank_transactions", "bill_payments", "bills", "journal_lines", "audit_log", "journal_entries", "accounts", "memberships"])
      await db.execute(sql`delete from ${sql.identifier(table)} where org_id in ${scope}`);
    await db.execute(sql`delete from organizations where id in ${scope}`);
  }
  if (users.length === 2) {
    await db.execute(sql`delete from auth_events where user_id in (${users[0]}, ${users[1]})`);
    await db.execute(sql`delete from users where id in (${users[0]}, ${users[1]})`);
  }
});

describe("owner-only Tax Forms API", () => {
  it("requires a session, rejects bearer auth and denies cross-org and non-owner membership", async () => {
    expect((await request(app).post(reviewUrl()).send({ year: 2026 })).status).toBe(401);
    expect((await owner.post(reviewUrl()).set("Authorization", "Bearer not-a-session").send({ year: 2026 })).status).toBe(401);
    expect((await outsider.post(reviewUrl()).send({ year: 2026 })).status).toBe(403);
    await addMember(orgId, users[1]!, "view_only", { actor: users[0] });
    expect((await outsider.post(reviewUrl()).send({ year: 2026 })).status).toBe(403);
    expect((await outsider.post(pdfUrl()).send({ year: 2026, kind: "schedule-c", acknowledged: true })).status).toBe(403);
  });
  it("uses paid dates not accrued bills, includes both boundaries, and never double-counts mirrored bank rows", async () => {
    const current = await owner.post(reviewUrl()).send({ year: 2026 });
    expect(current.status).toBe(200);
    expect(current.body.candidates).toHaveLength(1);
    expect(current.body.candidates[0]).toMatchObject({ total: "2500.00", confirmedTotal: "0.00", aboveThreshold: true });
    expect(current.body.candidates[0].payments).toHaveLength(2);
    const prior = await owner.post(reviewUrl()).send({ year: 2025 });
    expect(prior.body.candidates[0]).toMatchObject({ total: "650.00", aboveThreshold: true });
    expect(current.headers["cache-control"]).toBe("no-store");
    const isolated = await owner.post(`/api/orgs/${otherOrgId}/tax-forms/review`).send({ year: 2026 });
    expect(isolated.status).toBe(200);
    expect(isolated.body.candidates).toHaveLength(0);
    expect(isolated.body.accounts.some((a: { id: string }) => a.id === accountIds["1000"])).toBe(false);
  });
  it("rejects foreign account/payment selections and never accepts TIN/address fields", async () => {
    expect((await owner.post(reviewUrl()).send({ year: 2026, mappings: [{ accountId: foreignAccountId, line: "11" }] })).status).toBe(400);
    expect((await owner.post(reviewUrl()).send({ year: 2026, confirmedPaymentIds: [foreignAccountId] })).status).toBe(400);
    expect((await owner.post(reviewUrl()).send({ year: 2026, tin: "not-collected", address: "not-collected" })).status).toBe(400);
    expect((await owner.post(reviewUrl()).send({ year: 2027 })).status).toBe(400);
  });
  it("requires acknowledgement and a matching source snapshot, and downloads a real private PDF", async () => {
    const r = await owner.post(reviewUrl()).send({ year: 2026, confirmedPaymentIds: [paymentId] });
    expect(r.body.candidates[0].confirmedTotal).toBe("2000.00");
    const body = { year: 2026, kind: "nec", vendor: "Draft Contractor Alpha", confirmedPaymentIds: [paymentId], sourceDigest: r.body.sourceDigest };
    expect((await owner.post(pdfUrl()).send(body)).status).toBe(409);
    expect((await owner.post(pdfUrl()).send({ ...body, acknowledged: true, sourceDigest: "stale" })).status).toBe(409);
    const pdf = await owner.post(pdfUrl()).send({ ...body, acknowledged: true });
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");
    expect(pdf.headers["content-disposition"]).toContain("DRAFT.pdf");
    expect(pdf.headers["cache-control"]).toBe("no-store");
    expect(Buffer.from(pdf.body).subarray(0, 5).toString()).toBe("%PDF-");
  });
  it("generates the two worksheets and rejects a ledger snapshot after new posting", async () => {
    const r = await owner.post(reviewUrl()).send({ year: 2026 });
    const count = async () => (await db.execute(sql`select count(*)::int as n from journal_entries where org_id = ${orgId}`)).rows[0]?.n;
    const before = await count();
    for (const kind of ["schedule-c", "sales-tax"]) {
      const result = await owner.post(pdfUrl()).send({ year: 2026, kind, acknowledged: true, sourceDigest: r.body.sourceDigest });
      expect(result.status).toBe(200);
    }
    expect(await count()).toBe(before);
    await postJournalEntry(orgId, { entryDate: "2026-08-01", source: "test", lines: [
      { accountId: accountIds["1000"]!, debit: 1n }, { accountId: accountIds["1100"]!, credit: 1n },
    ] }, { actor: users[0], idempotencyKey: `tax-review-${nonce}` });
    expect((await owner.post(pdfUrl()).send({ year: 2026, kind: "schedule-c", acknowledged: true, sourceDigest: r.body.sourceDigest })).status).toBe(409);
  });
  it.skipIf(!process.env.TAX_RUNTIME_SMOKE)("serves the compiled running workflow and pinned PDF assets", async () => {
    const base = "http://127.0.0.1:8080";
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `tax-draft-owner-${nonce}@example.test`, password: "draft-review-test-password" }) });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const headers = { "Content-Type": "application/json", Cookie: cookie };
    const r = await fetch(base + reviewUrl(), { method: "POST", headers, body: JSON.stringify({ year: 2026, confirmedPaymentIds: [paymentId] }) });
    expect(r.status).toBe(200);
    const review = await r.json() as { sourceDigest: string };
    const pdf = await fetch(base + pdfUrl(), { method: "POST", headers, body: JSON.stringify({
      year: 2026, kind: "nec", vendor: "Draft Contractor Alpha", confirmedPaymentIds: [paymentId],
      sourceDigest: review.sourceDigest, acknowledged: true,
    }) });
    expect(pdf.status).toBe(200);
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");
  });
  it("revalidates revoked owner membership before reading or generating", async () => {
    await db.execute(sql`update memberships set revoked_at = now() where org_id = ${orgId} and user_id = ${users[0]}`);
    expect((await owner.post(reviewUrl()).send({ year: 2026 })).status).toBe(403);
    expect((await owner.post(pdfUrl()).send({ year: 2026, kind: "schedule-c", acknowledged: true })).status).toBe(403);
  });
});
