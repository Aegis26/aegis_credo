import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import router, { type MachinePrincipal } from "./machine-finance";
import {
  CreateIntegrationGlEntryResponse,
  GetIntegrationReportsResponse,
  ListIntegrationGlEntriesResponse,
} from "@workspace/api-zod";

function appFor(machine?: MachinePrincipal) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.machine = machine;
    next();
  });
  app.use(router);
  return app;
}

describe("machine finance authorization boundary", () => {
  it("accepts the exact generated GL success response shape", () => {
    const entry = {
      id: "00000000-0000-0000-0000-000000000001",
      entryDate: "2026-01-01",
      memo: null,
      source: "machine_integration",
      postedAt: "2026-01-01T00:00:00.000Z",
      lines: [{
        id: "00000000-0000-0000-0000-000000000002",
        accountId: "00000000-0000-0000-0000-000000000003",
        debit: "10.00",
        credit: "0.00",
        memo: null,
      }],
    };
    const created = CreateIntegrationGlEntryResponse.parse(entry);
    const listed = ListIntegrationGlEntriesResponse.parse({ entries: [entry] });
    expect(created.source).toBe("machine_integration");
    expect(created.postedAt).toBeInstanceOf(Date);
    expect(created.lines[0]).toMatchObject(entry.lines[0]);
    expect(listed.entries[0].lines[0]).toMatchObject(entry.lines[0]);
  });

  it("accepts the aggregate reports contract shape", () => {
    const row = { accountId: "account", code: "1000", name: "Cash", type: "asset", debit: "10.00", credit: "0.00" };
    const amountRow = { accountId: "account", code: "1000", name: "Cash", amount: "10.00" };
    expect(GetIntegrationReportsResponse.parse({
      trialBalance: { rows: [row], totalDebit: "10.00", totalCredit: "0.00", difference: "10.00", balanced: false },
      profitAndLoss: { revenue: [], expenses: [], totalRevenue: "0.00", totalExpenses: "0.00", netIncome: "0.00" },
      balanceSheet: {
        assets: [amountRow], liabilities: [], equity: [], totalAssets: "10.00",
        totalLiabilities: "0.00", totalEquity: "0.00", netIncome: "0.00",
        equityWithIncome: "0.00", totalLiabilitiesAndEquity: "0.00", balanced: false,
      },
    })).toBeTruthy();
  });

  it("rejects a request for an org other than the credential org", async () => {
    const response = await request(appFor({
      credentialId: "credential",
      orgId: "00000000-0000-0000-0000-000000000001",
      scopes: ["read:invoices"],
    })).get("/integrations/orgs/00000000-0000-0000-0000-000000000002/invoices");
    expect(response.status).toBe(403);
  });

  it("rejects a request when the required scope is absent", async () => {
    const response = await request(appFor({
      credentialId: "credential",
      orgId: "00000000-0000-0000-0000-000000000001",
      scopes: [],
    })).get("/integrations/orgs/00000000-0000-0000-0000-000000000001/invoices");
    expect(response.status).toBe(403);
  });

  it("validates invoice idempotency before touching the ledger", async () => {
    const response = await request(appFor({
      credentialId: "credential",
      orgId: "00000000-0000-0000-0000-000000000001",
      scopes: ["write:invoices"],
    })).post("/integrations/orgs/00000000-0000-0000-0000-000000000001/invoices")
      .send({
        customer: "Acme",
        invoiceDate: "2026-01-01",
        dueDate: "2026-02-01",
        amount: "10.00",
      });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Invalid request.");
  });
});