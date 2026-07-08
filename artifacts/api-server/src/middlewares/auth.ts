import type { Request, Response, NextFunction } from "express";
import { UnauthorizedError } from "../lib/errors";

/**
 * Gate for protected routes. Rejects with 401 before any handler runs unless a
 * valid session with a server-set userId is present. On success it copies the
 * identity onto req.userId for convenience.
 */
export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const userId = req.session?.userId;
  if (!userId) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }
  req.userId = userId;
  next();
}

/**
 * Read the authenticated identity inside a handler. Throws UnauthorizedError
 * (→ 401) if somehow reached without a session, so identity is never undefined
 * downstream and can never be spoofed by the client.
 */
export function getSessionUserId(req: Request): string {
  const userId = req.session?.userId ?? req.userId;
  if (!userId) throw new UnauthorizedError();
  return userId;
}
