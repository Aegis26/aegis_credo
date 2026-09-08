import type { Request, Response, NextFunction } from "express";

/**
 * CSRF defense-in-depth (second layer alongside the SameSite=lax cookie):
 * every state-changing request (non-GET/HEAD/OPTIONS) that carries an Origin
 * header must originate from one of the app's own domains, or it is rejected
 * with 403. Requests WITHOUT an Origin header pass through — curl, server-to-
 * server calls, and legacy same-origin edge cases never send one, and a
 * cross-site browser request always does.
 *
 * The allowlist is DERIVED FROM THE ENVIRONMENT, never hardcoded:
 * - REPLIT_DOMAINS (comma-separated production/published domains — includes
 *   any custom domain Replit attaches to the deployment)
 * - REPLIT_DEV_DOMAIN (the development preview domain)
 * It is re-read per request so env changes never require a code change.
 */
function allowedHosts(): Set<string> {
  const hosts = new Set<string>();
  for (const d of (process.env.REPLIT_DOMAINS ?? "").split(",")) {
    const t = d.trim().toLowerCase();
    if (t) hosts.add(t);
  }
  const dev = process.env.REPLIT_DEV_DOMAIN?.trim().toLowerCase();
  if (dev) hosts.add(dev);
  const publicAppUrl = process.env.PUBLIC_APP_URL?.trim();
  if (publicAppUrl) {
    try {
      const parsed = new URL(publicAppUrl);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        hosts.add(parsed.host.toLowerCase());
      }
    } catch {
      // Invalid deployment configuration grants no origin access.
    }
  }
  return hosts;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function originCheck(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) return next();

  const origin = req.headers.origin;
  if (!origin) return next(); // no Origin: not a cross-site browser request

  let host: string;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    res.status(403).json({ error: "Invalid Origin header." });
    return;
  }

  if (allowedHosts().has(host)) return next();

  // Local development fallback: the dev proxy serves on localhost. Match
  // EXACT loopback hostnames only — never a prefix — so lookalikes such as
  // 127.0.0.1.attacker.com stay rejected.
  if (process.env.NODE_ENV !== "production") {
    const hostname = new URL(origin).hostname.toLowerCase();
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]") {
      return next();
    }
  }

  res.status(403).json({ error: "Cross-origin request rejected." });
}
