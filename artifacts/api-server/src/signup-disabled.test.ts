import { describe, it, expect, afterAll, afterEach } from "vitest";
import request from "supertest";
import { pool } from "@workspace/db";
import { createApp } from "./app";
import { isPublicSignupEnabled } from "./routes/auth";

// vitest.config.ts sets ALLOW_PUBLIC_SIGNUP="true" for the other suites; this
// suite overrides/deletes it per-case (the flag is read at request time) and
// restores it afterwards.
const app = createApp();
const ORIGINAL = process.env.ALLOW_PUBLIC_SIGNUP;

afterEach(() => {
  process.env.ALLOW_PUBLIC_SIGNUP = ORIGINAL;
});

afterAll(async () => {
  await pool.end();
});

function trySignup() {
  return request(app)
    .post("/api/auth/signup")
    .send({
      email: `blocked.${Date.now().toString(36)}@example.test`,
      password: "correct-horse-battery",
    });
}

describe("public signup is fail-closed", () => {
  it("rejects signup when ALLOW_PUBLIC_SIGNUP is unset (403)", async () => {
    delete process.env.ALLOW_PUBLIC_SIGNUP;
    const res = await trySignup();
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Signup is disabled.");
    // No session cookie is issued on a rejected signup.
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("rejects signup when the flag is empty (403)", async () => {
    process.env.ALLOW_PUBLIC_SIGNUP = "";
    const res = await trySignup();
    expect(res.status).toBe(403);
  });

  it.each(["false", "0", "TRUE", "True", " true", "yes", "1"])(
    "rejects signup for malformed/non-exact value %j (403)",
    async (value) => {
      process.env.ALLOW_PUBLIC_SIGNUP = value;
      const res = await trySignup();
      expect(res.status).toBe(403);
    },
  );

  it("allows signup only for the exact string \"true\" (201)", async () => {
    process.env.ALLOW_PUBLIC_SIGNUP = "true";
    const res = await trySignup();
    expect(res.status).toBe(201);
    expect(res.body.user.id).toBeTruthy();
  });

  it("isPublicSignupEnabled is strict", () => {
    delete process.env.ALLOW_PUBLIC_SIGNUP;
    expect(isPublicSignupEnabled()).toBe(false);
    process.env.ALLOW_PUBLIC_SIGNUP = "";
    expect(isPublicSignupEnabled()).toBe(false);
    process.env.ALLOW_PUBLIC_SIGNUP = "false";
    expect(isPublicSignupEnabled()).toBe(false);
    process.env.ALLOW_PUBLIC_SIGNUP = "true";
    expect(isPublicSignupEnabled()).toBe(true);
  });
});
