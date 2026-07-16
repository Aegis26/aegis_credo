import express, { type Express } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import pinoHttp from "pino-http";
import { pool } from "@workspace/db";
import { createRouter } from "./routes";
import { logger } from "./lib/logger";
import { assertTokenKeyAtStartup } from "./lib/token-crypto";
import { originCheck } from "./middlewares/origin-check";

export interface AppOptions {
  /** Max auth requests per IP per window. Overridable for tests. */
  authRateLimitMax?: number;
  /** Max requests per IP per window across the whole API. Overridable for tests. */
  apiRateLimitMax?: number;
  /** Max requests per IP per window on expensive endpoints. Overridable for tests. */
  heavyRateLimitMax?: number;
}

export function createApp(options: AppOptions = {}): Express {
  const app: Express = express();
  const isProduction = process.env.NODE_ENV === "production";

  const secret = process.env.SESSION_SECRET;
  if (!secret && isProduction) {
    throw new Error(
      "SESSION_SECRET environment variable is required in production.",
    );
  }

  // FAIL CLOSED like SESSION_SECRET: in production the app refuses to start
  // without a valid 32-byte base64 TOKEN_ENCRYPTION_KEY. In development a set
  // key is validated; an unset key is tolerated (bank features throw at use).
  assertTokenKeyAtStartup(isProduction);

  // Behind Replit's reverse proxy: trust one hop so req.ip and Secure cookies
  // reflect the real client and the TLS-terminated origin.
  app.set("trust proxy", 1);
  // Don't advertise the framework.
  app.disable("x-powered-by");

  app.use(
    pinoHttp({
      logger,
      serializers: {
        req(req) {
          return {
            id: req.id,
            method: req.method,
            url: req.url?.split("?")[0],
          };
        },
        res(res) {
          return {
            statusCode: res.statusCode,
          };
        },
      },
    }),
  );
  // CSRF defense-in-depth: reject state-changing requests whose Origin is not
  // one of our own domains (REPLIT_DOMAINS + dev domain). The UI is same-origin
  // behind the shared proxy, so no CORS middleware is needed or wanted.
  app.use(originCheck);
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  const PgStore = connectPgSimple(session);
  app.use(
    session({
      name: "sid",
      store: new PgStore({
        pool,
        tableName: "session",
        createTableIfMissing: false,
      }),
      secret: secret ?? "insecure-dev-secret-do-not-use-in-production",
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        secure: isProduction,
        sameSite: "lax",
        maxAge: 1000 * 60 * 60 * 24 * 7,
      },
    }),
  );

  app.use(
    "/api",
    createRouter({
      authRateLimitMax: options.authRateLimitMax,
      apiRateLimitMax: options.apiRateLimitMax,
      heavyRateLimitMax: options.heavyRateLimitMax,
    }),
  );

  // Final safety net: anything that escapes route-level handling (most
  // commonly a malformed-JSON body rejected by express.json) gets a uniform
  // JSON body instead of Express's default HTML error page, and the real
  // error is logged server-side. Never echo err.message to the client here.
  app.use(
    (
      err: unknown,
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      if (res.headersSent) return next(err);
      const isBodyParseError =
        typeof err === "object" &&
        err !== null &&
        ((err as { type?: string }).type === "entity.parse.failed" ||
          (err instanceof SyntaxError &&
            (err as { status?: number }).status === 400));
      req.log?.error({ err }, "Unhandled error reached final middleware");
      if (isBodyParseError) {
        res.status(400).json({ error: "Invalid request." });
      } else {
        res.status(500).json({ error: "Internal error." });
      }
    },
  );

  return app;
}

const app = createApp();
export default app;
