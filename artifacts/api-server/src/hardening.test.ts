import { describe, it, expect } from "vitest";
import request from "supertest";
import type { Response } from "express";
import { createApp } from "./app";
import { sendLedgerError } from "./lib/errors";

// Fixes under test:
// 1. Unexpected errors return a generic body — err.message is NEVER echoed.
// 2. Malformed JSON gets a uniform JSON 400, not Express's HTML error page.
// 3. Global + heavy-endpoint rate limiting (env/option configurable).
// 4. x-powered-by disabled.

function fakeRes() {
  const out: { status?: number; body?: unknown } = {};
  const res = {
    req: { log: { error: () => {} } },
    status(code: number) {
      out.status = code;
      return res;
    },
    json(body: unknown) {
      out.body = body;
    },
  };
  return { res: res as unknown as Response, out };
}

describe("generic 500 (no internal detail leaks)", () => {
  it("returns 'Internal error.' for an unexpected Error, never its message", () => {
    const { res, out } = fakeRes();
    const secret =
      'duplicate key value violates unique constraint "users_email_key"';
    sendLedgerError(res, new Error(secret));
    expect(out.status).toBe(500);
    expect(out.body).toEqual({ error: "Internal error." });
    expect(JSON.stringify(out.body)).not.toContain("constraint");
    expect(JSON.stringify(out.body)).not.toContain(secret);
  });

  it("returns 'Internal error.' for a thrown non-Error too", () => {
    const { res, out } = fakeRes();
    sendLedgerError(res, "raw string with /internal/path.ts");
    expect(out.status).toBe(500);
    expect(out.body).toEqual({ error: "Internal error." });
  });
});

describe("final error middleware", () => {
  it("returns uniform JSON 400 for malformed JSON bodies (not HTML)", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/auth/login")
      .set("Content-Type", "application/json")
      .send('{"email": "broken@'); // invalid JSON
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body).toEqual({ error: "Invalid request." });
    // No stack trace / file path leaks:
    expect(res.text).not.toContain("at ");
    expect(res.text).not.toContain("node_modules");
  });
});

describe("rate limiting", () => {
  it("global /api limiter returns 429 after the cap", async () => {
    const app = createApp({ apiRateLimitMax: 3 });
    for (let i = 0; i < 3; i++) {
      const res = await request(app).get("/api/healthz");
      expect(res.status).toBe(200);
    }
    const blocked = await request(app).get("/api/healthz");
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({
      error: "Too many requests. Try again later.",
    });
  });

  it("heavy-endpoint limiter is stricter than the global one", async () => {
    const app = createApp({ apiRateLimitMax: 100, heavyRateLimitMax: 2 });
    // Unauthenticated requests still consume the heavy budget (401s).
    for (let i = 0; i < 2; i++) {
      const res = await request(app).post("/api/practice/batch-export").send({});
      expect(res.status).toBe(401);
    }
    const blocked = await request(app)
      .post("/api/practice/batch-export")
      .send({});
    expect(blocked.status).toBe(429);
    // A cheap endpoint is NOT affected by the heavy limiter.
    const cheap = await request(app).get("/api/healthz");
    expect(cheap.status).toBe(200);
  });

  it("default limits do not trip under normal UI-scale usage", async () => {
    const app = createApp();
    for (let i = 0; i < 50; i++) {
      const res = await request(app).get("/api/healthz");
      expect(res.status).toBe(200);
    }
  });
});

describe("x-powered-by", () => {
  it("is not sent", async () => {
    const app = createApp();
    const res = await request(app).get("/api/healthz");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
});
