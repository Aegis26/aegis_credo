import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "./app";
import { pool } from "@workspace/db";

/**
 * CSRF defense-in-depth regression tests. Two independent layers are locked in:
 * (a) the session cookie is SameSite=Lax (browser refuses to attach it to
 *     cross-site POSTs), and
 * (b) the origin-check middleware rejects state-changing requests carrying a
 *     foreign Origin header with 403 — so a future SameSite change cannot
 *     silently remove CSRF protection.
 */

const app = createApp({ authRateLimitMax: 1000 });
const EMAIL = `csrf-${Date.now()}@test.example`;
const PASSWORD = "correct-horse-battery-staple-9";

const DEV_DOMAIN = process.env.REPLIT_DEV_DOMAIN;

afterAll(async () => {
  await pool.query(
    "DELETE FROM auth_events WHERE user_id IN (SELECT id FROM users WHERE email = $1)",
    [EMAIL],
  );
  await pool.query("DELETE FROM users WHERE email = $1", [EMAIL]);
});

describe("CSRF layer (a): SameSite cookie", () => {
  it("sets the session cookie with SameSite=Lax, HttpOnly", async () => {
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email: EMAIL, password: PASSWORD, name: "CSRF Test" });
    expect(res.status).toBe(201);
    const setCookie = res.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    const sid = ([] as string[]).concat(setCookie!).find((c) => c.startsWith("sid="));
    expect(sid).toBeDefined();
    expect(sid!.toLowerCase()).toContain("samesite=lax");
    expect(sid!.toLowerCase()).toContain("httponly");
  });
});

describe("CSRF layer (b): origin check on state-changing requests", () => {
  it("rejects a POST with a foreign Origin header with 403", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .set("Origin", "https://evil.example")
      .send({ email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(403);
  });

  it("rejects a POST with a malformed Origin header with 403", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .set("Origin", "not a url")
      .send({ email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(403);
  });

  it("rejects lookalike origins (suffix/prefix tricks)", async () => {
    for (const origin of [
      "https://evil.example.replit.app.attacker.com",
      "https://127.0.0.1.attacker.com",
      "https://localhost.attacker.com",
      DEV_DOMAIN ? `https://${DEV_DOMAIN}.attacker.com` : "https://x.attacker.com",
    ]) {
      const res = await request(app)
        .post("/api/auth/login")
        .set("Origin", origin)
        .send({ email: EMAIL, password: PASSWORD });
      expect(res.status).toBe(403);
    }
  });

  it("allows a POST with the app's own dev-domain Origin", async () => {
    if (!DEV_DOMAIN) return; // env-dependent; covered in dev/prod environments
    const res = await request(app)
      .post("/api/auth/login")
      .set("Origin", `https://${DEV_DOMAIN}`)
      .send({ email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(200);
  });

  it("allows a POST with no Origin header (curl / server-to-server)", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(200);
  });

  it("does NOT block GET requests regardless of Origin", async () => {
    const res = await request(app)
      .get("/api/auth/session")
      .set("Origin", "https://evil.example");
    expect(res.status).not.toBe(403);
  });

  it("foreign-Origin rejection happens even with a valid session cookie (the real CSRF scenario)", async () => {
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: EMAIL, password: PASSWORD });
    expect(login.status).toBe(200);
    const cookie = login.headers["set-cookie"];
    const res = await request(app)
      .post("/api/orgs")
      .set("Cookie", cookie)
      .set("Origin", "https://evil.example")
      .send({ name: "Should Never Exist Org" });
    expect(res.status).toBe(403);
  });
});
