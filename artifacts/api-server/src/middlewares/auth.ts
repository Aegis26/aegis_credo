import type { Request, Response, NextFunction } from "express";
import { UnauthorizedError } from "../lib/errors";
import { getUserById, normalizeEmail } from "../lib/auth-service";

/**
 * Gate for protected routes. Rejects with 401 before any handler runs unless a
 * valid session with a server-set userId is present. On success it copies the
 * identity onto req.userId for convenience.
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const userId = req.session?.userId;
  const sessionEmail = req.session?.authenticatedEmail;
  const sessionVersion = req.session?.userSessionVersion;
  if (!userId || !sessionEmail || sessionVersion == null) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }
  const user = await getUserById(userId);
  if (!user || user.deactivatedAt || user.sessionVersion !== sessionVersion ||
      normalizeEmail(user.email) !== normalizeEmail(sessionEmail)) {
    await new Promise<void>((resolve) => {
      req.session.destroy(() => resolve());
    });
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
