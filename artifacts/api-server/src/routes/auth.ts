import { Router, type IRouter, type Request } from "express";
import rateLimit from "express-rate-limit";
import {
  SignupBody,
  SignupResponse,
  LoginBody,
  LoginResponse,
  GetSessionResponse,
} from "@workspace/api-zod";
import type { User } from "@workspace/db";
import { signup, login, getUserById, recordAuthEvent } from "../lib/auth-service";
import { sendLedgerError, UnauthorizedError } from "../lib/errors";

function authUser(user: User): { id: string; email: string; name: string | null } {
  return { id: user.id, email: user.email, name: user.name };
}

// express-session's regenerate/save/destroy are callback-based; promisify so the
// response is only sent after the session (and its Set-Cookie) is persisted.
function regenerateSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}
function saveSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  });
}
function destroySession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.destroy((err) => (err ? reject(err) : resolve()));
  });
}

export interface AuthRouterOptions {
  /** Max auth requests per IP per window. Overridable for tests. */
  rateLimitMax?: number;
}

export function createAuthRouter(options: AuthRouterOptions = {}): IRouter {
  const router = Router();
  const max =
    options.rateLimitMax ?? Number(process.env.AUTH_RATE_LIMIT_MAX ?? 50);
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) =>
      res.status(429).json({ error: "Too many requests. Try again later." }),
  });

  router.post("/auth/signup", limiter, async (req, res) => {
    try {
      const body = SignupBody.parse(req.body);
      const user = await signup({
        email: body.email,
        password: body.password,
        name: body.name,
        ip: req.ip,
      });
      // Fresh session id on privilege change to prevent session fixation.
      await regenerateSession(req);
      req.session.userId = user.id;
      await saveSession(req);
      res.status(201).json(SignupResponse.parse({ user: authUser(user) }));
    } catch (err) {
      sendLedgerError(res, err);
    }
  });

  router.post("/auth/login", limiter, async (req, res) => {
    try {
      const body = LoginBody.parse(req.body);
      const user = await login({
        email: body.email,
        password: body.password,
        ip: req.ip,
      });
      await regenerateSession(req);
      req.session.userId = user.id;
      await saveSession(req);
      res.status(200).json(LoginResponse.parse({ user: authUser(user) }));
    } catch (err) {
      sendLedgerError(res, err);
    }
  });

  router.post("/auth/logout", async (req, res) => {
    try {
      const userId = req.session?.userId;
      if (userId) await recordAuthEvent("logout", { userId, ip: req.ip });
      await destroySession(req);
      res.clearCookie("sid");
      res.status(204).end();
    } catch (err) {
      sendLedgerError(res, err);
    }
  });

  router.get("/auth/session", async (req, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) throw new UnauthorizedError();
      const user = await getUserById(userId);
      if (!user) throw new UnauthorizedError();
      res.status(200).json(GetSessionResponse.parse({ user: authUser(user) }));
    } catch (err) {
      sendLedgerError(res, err);
    }
  });

  return router;
}
