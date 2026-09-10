import type { Request, Response, NextFunction } from "express";
import { allowedOrigins, isProduction } from "../lib/runtime-config";

/**
 * CSRF defense-in-depth (second layer alongside the SameSite=lax cookie):
 * every state-changing request (non-GET/HEAD/OPTIONS) that carries an Origin
 * header must originate from one of the app's own domains, or it is rejected
 * with 403. Requests WITHOUT an Origin header pass through — curl, server-to-
 * server calls, and legacy same-origin edge cases never send one, and a
 * cross-site browser request always does.
 *
 * The allowlist is derived from ALLOWED_ORIGINS as exact origins, never
 * hardcoded. Production accepts HTTPS entries only and requires at least one.
 * It is re-read per request so env changes never require a code change.
 */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function originCheck(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) return next();

  const origin = req.headers.origin;
  if (!origin) return next(); // no Origin: not a cross-site browser request

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    res.status(403).json({ error: "Invalid Origin header." });
    return;
  }

  if (allowedOrigins().has(parsed.origin)) return next();

  // Local development fallback: the dev proxy serves on localhost. Match
  // EXACT loopback hostnames only — never a prefix — so lookalikes such as
  // 127.0.0.1.attacker.com stay rejected.
  if (!isProduction()) {
    const hostname = parsed.hostname.toLowerCase();
    const forwardedHost = req.get("x-forwarded-host")?.split(",")[0]?.trim();
    const requestHost = forwardedHost || req.get("host");
    if (
      parsed.host === requestHost ||
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]"
    ) {
      return next();
    }
  }

  res.status(403).json({ error: "Cross-origin request rejected." });
}
