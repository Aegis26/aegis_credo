import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authenticate, audit } = vi.hoisted(() => ({
  authenticate: vi.fn(),
  audit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/machine-credentials", () => ({
  authenticateMachineKey: authenticate,
  auditMachineCall: audit,
  safeAuditMachineCall: audit,
}));

import {
  hasMachineBearer,
  requireMachineCredential,
  requireMachineOrg,
  requireMachineScope,
} from "./machine-credentials";

type Principal = { credentialId: string; orgId: string; scopes: string[] };
const principal: Principal = {
  credentialId: "cred-1", orgId: "org-1", scopes: ["read:invoices"],
};

function appFor(path = "/orgs/:orgId/data") {
  const app = express();
  app.use(express.json());
  app.get(path, requireMachineCredential, requireMachineOrg(), requireMachineScope("read:invoices"), (_req, res) => res.json({ ok: true }));
  return app;
}

beforeEach(() => {
  authenticate.mockReset();
  audit.mockClear();
  authenticate.mockResolvedValue(principal);
});
afterEach(() => vi.clearAllMocks());

describe("machine credential authentication middleware", () => {
  it("accepts a valid bearer key", async () => {
    const res = await request(appFor()).get("/orgs/org-1/data").set("Authorization", "Bearer credo_sk_live_valid");
    expect(res.status).toBe(200);
  });
  it("rejects a missing bearer", async () => {
    const res = await request(appFor()).get("/orgs/org-1/data");
    expect(res.status).toBe(401);
  });
  it("rejects an invalid key", async () => {
    authenticate.mockResolvedValue(null);
    const res = await request(appFor()).get("/orgs/org-1/data").set("Authorization", "Bearer bad");
    expect(res.status).toBe(401);
  });
  it("does not fall back to a cookie when bearer is invalid", async () => {
    authenticate.mockResolvedValue(null);
    const res = await request(appFor()).get("/orgs/org-1/data").set("Authorization", "Bearer bad").set("Cookie", "sid=valid-session");
    expect(res.status).toBe(401);
  });
  it("rejects a non-Bearer authorization scheme", async () => {
    const res = await request(appFor()).get("/orgs/org-1/data").set("Authorization", "Basic abc");
    expect(res.status).toBe(401);
  });
  it("rejects an empty bearer token", async () => {
    authenticate.mockResolvedValue(null);
    const res = await request(appFor()).get("/orgs/org-1/data").set("Authorization", "Bearer ");
    expect(res.status).toBe(401);
  });
  it("rejects an org mismatch", async () => {
    const res = await request(appFor()).get("/orgs/other/data").set("Authorization", "Bearer key");
    expect(res.status).toBe(403);
  });
  it("rejects a missing scope", async () => {
    authenticate.mockResolvedValue({ ...principal, scopes: ["read:gl"] });
    const res = await request(appFor()).get("/orgs/org-1/data").set("Authorization", "Bearer key");
    expect(res.status).toBe(403);
  });
  it("allows a granted scope", async () => {
    const res = await request(appFor()).get("/orgs/org-1/data").set("Authorization", "Bearer key");
    expect(res.body).toEqual({ ok: true });
  });
  it("attaches the principal for downstream handlers", async () => {
    const app = express();
    app.get("/", requireMachineCredential, (req, res) => res.json(req.machinePrincipal));
    const res = await request(app).get("/").set("Authorization", "Bearer key");
    expect(res.body.credentialId).toBe("cred-1");
  });
  it("audits an invalid key without a credential id", async () => {
    authenticate.mockResolvedValue(null);
    await request(appFor()).get("/orgs/org-1/data").set("Authorization", "Bearer bad");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }));
    expect(audit.mock.calls[0][0]).not.toHaveProperty("credentialId");
  });
  it("audits an authenticated request on completion", async () => {
    await request(appFor()).get("/orgs/org-1/data").set("Authorization", "Bearer key");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ credentialId: "cred-1", status: 200 }));
  });
  it("audits org denial through the completion hook", async () => {
    await request(appFor()).get("/orgs/other/data").set("Authorization", "Bearer key");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ status: 403, orgId: "org-1" }));
  });
  it("audits scope denial through the completion hook", async () => {
    authenticate.mockResolvedValue({ ...principal, scopes: [] });
    await request(appFor()).get("/orgs/org-1/data").set("Authorization", "Bearer key");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ status: 403, credentialId: "cred-1" }));
  });
  it("recognizes only the Bearer prefix", () => {
    const req = { headers: { authorization: "Bearer x" } } as never;
    expect(hasMachineBearer(req)).toBe(true);
    expect(hasMachineBearer({ headers: { authorization: "bearer x" } } as never)).toBe(false);
  });
  it("does not expose the bearer in audit payload", async () => {
    await request(appFor()).get("/orgs/org-1/data").set("Authorization", "Bearer secret-key");
    expect(JSON.stringify(audit.mock.calls)).not.toContain("secret-key");
  });
  it("supports a write scope independently", async () => {
    const app = express();
    app.post("/orgs/:orgId/write", requireMachineCredential, requireMachineOrg(), requireMachineScope("write:invoices"), (_req, res) => res.sendStatus(204));
    authenticate.mockResolvedValue({ ...principal, scopes: ["write:invoices"] });
    expect((await request(app).post("/orgs/org-1/write").set("Authorization", "Bearer k")).status).toBe(204);
  });
  it("rejects a principal absent from request state", async () => {
    const app = express();
    app.get("/orgs/:orgId", requireMachineOrg(), (_req, res) => res.sendStatus(204));
    expect((await request(app).get("/orgs/org-1")).status).toBe(401);
  });
  it("does not accept a bearer as an org id", async () => {
    const res = await request(appFor()).get("/orgs/credo_sk_live_key/data").set("Authorization", "Bearer key");
    expect(res.status).toBe(403);
  });
  it("preserves the original method in audit", async () => {
    await request(appFor()).get("/orgs/org-1/data").set("Authorization", "Bearer k");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ method: "GET", path: "/orgs/org-1/data" }));
  });
  it("does not query authentication for a missing header", async () => {
    await request(appFor()).get("/orgs/org-1/data");
    expect(authenticate).not.toHaveBeenCalled();
  });
});