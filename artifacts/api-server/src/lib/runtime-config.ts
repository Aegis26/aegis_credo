import type { CookieOptions } from "express";

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function parseHttpsOrigin(raw: string, name: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must contain valid absolute URLs.`);
  }
  if (url.protocol !== "https:" || url.origin !== url.toString().replace(/\/$/, "")) {
    throw new Error(`${name} entries must be exact HTTPS origins without paths.`);
  }
  return url.origin;
}

export function allowedOrigins(): Set<string> {
  const origins = new Set<string>();
  for (const raw of (process.env.ALLOWED_ORIGINS ?? "").split(",")) {
    const value = raw.trim();
    if (!value) continue;
    if (!isProduction() && /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(value)) {
      origins.add(new URL(value).origin);
      continue;
    }
    origins.add(parseHttpsOrigin(value, "ALLOWED_ORIGINS"));
  }
  if (isProduction() && origins.size === 0) {
    throw new Error(
      "ALLOWED_ORIGINS must contain at least one exact HTTPS origin in production.",
    );
  }
  return origins;
}

export function publicAppUrl(): string {
  const raw = process.env.PUBLIC_APP_URL?.trim();
  if (!raw) {
    if (isProduction()) {
      throw new Error("PUBLIC_APP_URL is required in production.");
    }
    return "";
  }
  const origin = parseHttpsOrigin(raw.replace(/\/$/, ""), "PUBLIC_APP_URL");
  return origin;
}

export function trustProxy(): number | false {
  const raw = process.env.TRUST_PROXY?.trim();
  if (!raw) {
    if (isProduction()) {
      throw new Error("TRUST_PROXY is required in production.");
    }
    return false;
  }
  if (raw === "false" || raw === "0") return false;
  const hops = Number(raw);
  if (!Number.isInteger(hops) || hops < 1 || hops > 10) {
    throw new Error("TRUST_PROXY must be false, 0, or an integer from 1 to 10.");
  }
  return hops;
}

export function sessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: isProduction(),
    sameSite: "lax",
    path: "/",
    maxAge: 1000 * 60 * 60 * 24 * 7,
  };
}

export function assertRuntimeConfig(): void {
  if (!["development", "test", "production"].includes(process.env.NODE_ENV ?? "")) {
    throw new Error("NODE_ENV must be development, test, or production.");
  }
  if (isProduction() && !process.env.SESSION_SECRET) {
    throw new Error("SESSION_SECRET environment variable is required in production.");
  }
  allowedOrigins();
  publicAppUrl();
  trustProxy();
  sessionCookieOptions();
}