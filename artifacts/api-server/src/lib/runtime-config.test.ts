import { afterEach, describe, expect, it } from "vitest";
import {
  allowedOrigins,
  assertRuntimeConfig,
  publicAppUrl,
  sessionCookieOptions,
  trustProxy,
} from "./runtime-config";

const KEYS = [
  "NODE_ENV",
  "SESSION_SECRET",
  "PUBLIC_APP_URL",
  "ALLOWED_ORIGINS",
  "TRUST_PROXY",
] as const;
const original = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of KEYS) {
    const value = original[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function productionConfig(): void {
  process.env.NODE_ENV = "production";
  process.env.SESSION_SECRET = "test-session-secret";
  process.env.PUBLIC_APP_URL = "https://books.example.com";
  process.env.ALLOWED_ORIGINS =
    "https://books.example.com,https://admin.example.com";
  process.env.TRUST_PROXY = "1";
}

describe("portable runtime configuration", () => {
  it("accepts exact production origins and secure host-only cookies", () => {
    productionConfig();
    expect([...allowedOrigins()]).toEqual([
      "https://books.example.com",
      "https://admin.example.com",
    ]);
    expect(publicAppUrl()).toBe("https://books.example.com");
    expect(trustProxy()).toBe(1);
    expect(sessionCookieOptions()).toMatchObject({
      secure: true,
      sameSite: "lax",
      path: "/",
    });
    expect(sessionCookieOptions()).not.toHaveProperty("domain");
    expect(() => assertRuntimeConfig()).not.toThrow();
  });

  it("fails closed when production origin, URL, or proxy config is absent", () => {
    productionConfig();
    delete process.env.ALLOWED_ORIGINS;
    expect(() => assertRuntimeConfig()).toThrow("ALLOWED_ORIGINS");

    productionConfig();
    delete process.env.PUBLIC_APP_URL;
    expect(() => assertRuntimeConfig()).toThrow("PUBLIC_APP_URL");

    productionConfig();
    delete process.env.TRUST_PROXY;
    expect(() => assertRuntimeConfig()).toThrow("TRUST_PROXY");
  });

  it("rejects insecure or path-bearing production configuration", () => {
    productionConfig();
    process.env.ALLOWED_ORIGINS = "http://books.example.com";
    expect(() => allowedOrigins()).toThrow("exact HTTPS origins");

    productionConfig();
    process.env.PUBLIC_APP_URL = "https://books.example.com/app";
    expect(() => publicAppUrl()).toThrow("without paths");

  });
});