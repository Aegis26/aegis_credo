/**
 * Phase 7 — accountant cockpit endpoints.
 *
 * The load-bearing part is access control: every cockpit endpoint derives the
 * user from the SESSION and enforces the practice grant SERVER-SIDE. These
 * tests prove the NEGATIVE per endpoint — a practice user with a perfectly
 * valid session for their own clients cannot reach an ungranted client's data
 * through ANY new endpoint — as well as the positive flows.
 *
 * Scenario: accountant P runs a practice. Client owner O owns three orgs
 * (A, B, C) and grants the practice access to A and B only. P must see
 * exactly A and B and be walled off from C everywhere.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { pool } from "@workspace/db";
import { createApp } from "./app";

const app = createApp();
const nonce = `p7${Date.now().toString(36)}`;
const PASSWORD = "correct-horse-battery";

const accountant = request.agent(app); // P — practice user
const owner = request.agent(app); // O — client org owner
const outsider = request.agent(app); // X — unrelated authed user

let practiceId: string;
let orgA: string;
let orgB: string;
let orgC: string; // never granted

beforeAll(async () => {
  const pSignup = await accountant
    .post("/api/auth/signup")
    .send({ email: `p7.acct.${nonce}@example.test`, password: PASSWORD });
  expect(pSignup.status).toBe(201);

  const oSignup = await owner
    .post("/api/auth/signup")
    .send({ email: `p7.owner.${nonce}@example.test`, password: PASSWORD });
  expect(oSignup.status).toBe(201);

  const xSignup = await outsider
    .post("/api/auth/signup")
    .send({ email: `p7.out.${nonce}@example.test`, password: PASSWORD });
  expect(xSignup.status).toBe(201);

  for (const [name, setter] of [
    [`P7 Client A ${nonce}`, (id: string) => (orgA = id)],
    [`P7 Client B ${nonce}`, (id: string) => (orgB = id)],
    [`P7 Client C ${nonce}`, (id: string) => (orgC = id)],
  ] as const) {
    const res = await owner.post("/api/orgs").send({ name });
    expect(res.status).toBe(201);
    setter(res.body.id);
  }

  const practice = await accountant
    .post("/api/practice")
    .send({ name: `P7 Firm ${nonce}` });
  expect(practice.status).toBe(201);
  practiceId = practice.body.id;

  // The CLIENT owner authorizes their own books to the firm (A and B only).
  for (const orgId of [orgA, orgB]) {
    const grant = await owner
      .post(`/api/practice/${practiceId}/clients`)
      .send({ orgId });
    expect(grant.status).toBe(201);
    expect(grant.body).toEqual({ practiceId, orgId, active: true });
  }
});

afterAll(async () => {
  await pool.end();
});

describe("granting is gated by members.manage on the CLIENT org", () => {
  it("the practice user cannot self-grant an org they do not administer", async () => {
    const res = await accountant
      .post(`/api/practice/${practiceId}/clients`)
      .send({ orgId: orgC });
    expect(res.status).toBe(403);
  });

  it("an unrelated authed user cannot grant someone else's org", async () => {
    const res = await outsider
      .post(`/api/practice/${practiceId}/clients`)
      .send({ orgId: orgA });
    expect(res.status).toBe(403);
  });

  it("rejects granting with no session", async () => {
    const res = await request(app)
      .post(`/api/practice/${practiceId}/clients`)
      .send({ orgId: orgA });
    expect(res.status).toBe(401);
  });
});

describe("the client list / switcher shows exactly the granted clients", () => {
  it("lists A and B, never C", async () => {
    const res = await accountant.get("/api/practice/clients");
    expect(res.status).toBe(200);
    const ids = res.body.clients.map((c: { orgId: string }) => c.orgId);
    expect(ids).toContain(orgA);
    expect(ids).toContain(orgB);
    expect(ids).not.toContain(orgC);
  });

  it("dashboard covers exactly the granted clients", async () => {
    const res = await accountant.get("/api/practice/dashboard");
    expect(res.status).toBe(200);
    const ids = res.body.clients.map((c: { orgId: string }) => c.orgId);
    expect(ids.sort()).toEqual([orgA, orgB].sort());
  });

  it("switch into a granted client works and returns the org", async () => {
    const res = await accountant.post(`/api/practice/switch/${orgA}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(orgA);
  });

  it("switch into the UNGRANTED client is 403", async () => {
    const res = await accountant.post(`/api/practice/switch/${orgC}`);
    expect(res.status).toBe(403);
  });
});

describe("close lifecycle on a granted client (positive path)", () => {
  let periodId: string;
  let taskId: string;
  let pbcId: string;

  it("creates a close period", async () => {
    const res = await accountant
      .post(`/api/clients/${orgA}/close-periods/create`)
      .send({ period: "2026-06" });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("open");
    periodId = res.body.id;
  });

  it("adds a checklist task and completes it", async () => {
    const add = await accountant
      .post(`/api/clients/${orgA}/close-periods/${periodId}/tasks`)
      .send({ title: "Reconcile bank", sortOrder: 1 });
    expect(add.status).toBe(201);
    taskId = add.body.id;

    const done = await accountant
      .post(`/api/clients/${orgA}/close-tasks/${taskId}/set-status`)
      .send({ status: "done" });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe("done");
  });

  it("runs the PBC round-trip: request → client responds → accept", async () => {
    const create = await accountant
      .post(`/api/clients/${orgA}/close-periods/${periodId}/pbc`)
      .send({ title: "June bank statement", detail: "PDF please" });
    expect(create.status).toBe(201);
    expect(create.body.status).toBe("requested");
    pbcId = create.body.id;

    // The CLIENT sees it on their own org-side view…
    const mine = await owner.get(`/api/orgs/${orgA}/close-status`);
    expect(mine.status).toBe(200);
    expect(
      mine.body.summary.pbc.items.some(
        (p: { id: string }) => p.id === pbcId,
      ),
    ).toBe(true);

    // …and responds through the org-side endpoint.
    const respond = await owner
      .post(`/api/orgs/${orgA}/pbc/${pbcId}/respond`)
      .send({ response: "Uploaded to the shared drive." });
    expect(respond.status).toBe(200);
    expect(respond.body.status).toBe("provided");

    const accept = await accountant.post(
      `/api/clients/${orgA}/pbc/${pbcId}/accept`,
    );
    expect(accept.status).toBe(200);
    expect(accept.body.status).toBe("accepted");
  });

  it("moves the period through its lifecycle and derives status", async () => {
    const review = await accountant
      .post(`/api/clients/${orgA}/close-periods/${periodId}/set-status`)
      .send({ status: "in_review" });
    expect(review.status).toBe(200);
    expect(review.body.status).toBe("in_review");

    const status = await accountant.get(
      `/api/clients/${orgA}/close-periods/${periodId}/status`,
    );
    expect(status.status).toBe(200);
    expect(status.body.tasks.done).toBe(1);
    expect(status.body.tasks.progress).toBe(1);
    expect(status.body.pbc.accepted).toBe(1);
    expect(status.body.pbc.open).toBe(0);

    const closed = await accountant
      .post(`/api/clients/${orgA}/close-periods/${periodId}/set-status`)
      .send({ status: "closed" });
    expect(closed.status).toBe(200);
    expect(closed.body.status).toBe("closed");
  });
});

describe("EVERY cockpit endpoint is walled off from the ungranted client", () => {
  let cPeriodId: string;
  let cPbcId: string;

  beforeAll(async () => {
    // Real close data exists on C (created by its owner via the library path
    // is unnecessary — the owner grants nothing; create via a second practice
    // the OWNER controls, proving the wall is per-practice-user).
    const ownPractice = await owner
      .post("/api/practice")
      .send({ name: `P7 Owner Firm ${nonce}` });
    expect(ownPractice.status).toBe(201);
    const grant = await owner
      .post(`/api/practice/${ownPractice.body.id}/clients`)
      .send({ orgId: orgC });
    expect(grant.status).toBe(201);

    const period = await owner
      .post(`/api/clients/${orgC}/close-periods/create`)
      .send({ period: "2026-06" });
    expect(period.status).toBe(201);
    cPeriodId = period.body.id;

    const pbc = await owner
      .post(`/api/clients/${orgC}/close-periods/${cPeriodId}/pbc`)
      .send({ title: "C statement" });
    expect(pbc.status).toBe(201);
    cPbcId = pbc.body.id;
  });

  const cases: Array<[string, () => request.Test]> = [
    ["list close periods", () => accountant.get(`/api/clients/${orgC}/close-periods`)],
    ["close status", () => accountant.get(`/api/clients/${orgC}/close-periods/${cPeriodId}/status`)],
    ["create close period", () => accountant.post(`/api/clients/${orgC}/close-periods/create`).send({ period: "2026-07" })],
    ["set period status", () => accountant.post(`/api/clients/${orgC}/close-periods/${cPeriodId}/set-status`).send({ status: "in_review" })],
    ["add close task", () => accountant.post(`/api/clients/${orgC}/close-periods/${cPeriodId}/tasks`).send({ title: "sneak" })],
    ["set task status", () => accountant.post(`/api/clients/${orgC}/close-tasks/${cPeriodId}/set-status`).send({ status: "done" })],
    ["create PBC request", () => accountant.post(`/api/clients/${orgC}/close-periods/${cPeriodId}/pbc`).send({ title: "sneak" })],
    ["accept PBC request", () => accountant.post(`/api/clients/${orgC}/pbc/${cPbcId}/accept`)],
    ["switch", () => accountant.post(`/api/practice/switch/${orgC}`)],
  ];

  for (const [label, go] of cases) {
    it(`${label} → 403 for the ungranted client`, async () => {
      const res = await go();
      expect(res.status).toBe(403);
    });
  }

  it("org-side close view is membership-gated: P is not a member of A", async () => {
    // Practice grant ≠ org membership. The client-facing endpoints run on the
    // ORG gate, so even a granted practice user is rejected there.
    const view = await accountant.get(`/api/orgs/${orgA}/close-status`);
    expect(view.status).toBe(403);
    const respond = await accountant
      .post(`/api/orgs/${orgA}/pbc/whatever/respond`)
      .send({ response: "nope" });
    expect(respond.status).toBe(403);
  });
});

describe("batch operations honor the grant boundary", () => {
  it("batch report across granted clients returns one sheet per client", async () => {
    const res = await accountant
      .post("/api/practice/batch-report")
      .send({ orgIds: [orgA, orgB], kind: "trialBalance" });
    expect(res.status).toBe(200);
    expect(res.body.clients.length).toBe(2);
    expect(res.body.sheets.length).toBe(2);
    expect(res.body.sheets[0].columns).toContain("Debit");
  });

  it("batch report including the ungranted client → 403", async () => {
    const res = await accountant
      .post("/api/practice/batch-report")
      .send({ orgIds: [orgA, orgC], kind: "profitAndLoss" });
    expect(res.status).toBe(403);
  });

  it("skipUnauthorized drops the ungranted client instead of leaking it", async () => {
    const res = await accountant
      .post("/api/practice/batch-report")
      .send({ orgIds: [orgA, orgC], kind: "balanceSheet", skipUnauthorized: true });
    expect(res.status).toBe(200);
    const ids = res.body.clients.map((c: { orgId: string }) => c.orgId);
    expect(ids).toEqual([orgA]);
  });

  it("batch export including the ungranted client → 403", async () => {
    const res = await accountant
      .post("/api/practice/batch-export")
      .send({ orgIds: [orgB, orgC], kind: "trialBalance", format: "csv" });
    expect(res.status).toBe(403);
  });

  it("batch export of granted clients yields downloadable files", async () => {
    const res = await accountant
      .post("/api/practice/batch-export")
      .send({ orgIds: [orgA, orgB], kind: "trialBalance", format: "csv" });
    expect(res.status).toBe(200);
    expect(res.body.files.length).toBe(2);
    expect(res.body.files[0].contentType).toContain("csv");
  });
});
