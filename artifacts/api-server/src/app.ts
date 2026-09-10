import express, { type Express } from "express";
import path from "node:path";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import pinoHttp from "pino-http";
import type { Logger } from "pino";
import { pool } from "@workspace/db";
import { createRouter } from "./routes";
import { logger } from "./lib/logger";
import { assertTokenKeyAtStartup } from "./lib/token-crypto";
import { originCheck } from "./middlewares/origin-check";
import {
  assertRuntimeConfig,
  isProduction,
  sessionCookieOptions,
  trustProxy,
} from "./lib/runtime-config";

export interface AppOptions {
  /** Max auth requests per IP per window. Overridable for tests. */
  authRateLimitMax?: number;
  /** Max requests per IP per window across the whole API. Overridable for tests. */
  apiRateLimitMax?: number;
  /** Max requests per IP per window on expensive endpoints. Overridable for tests. */
  heavyRateLimitMax?: number;
  platformResetRateLimitMax?: number;
  /** Injectable structured logger used by security/logging tests. */
  httpLogger?: Logger;
}

export function createApp(options: AppOptions = {}): Express {
  const app: Express = express();
  const production = isProduction();
  assertRuntimeConfig();

  const secret = process.env.SESSION_SECRET;
  if (!secret && production) {
    throw new Error(
      "SESSION_SECRET environment variable is required in production.",
    );
  }

  // FAIL CLOSED like SESSION_SECRET: in production the app refuses to start
  // without a valid 32-byte base64 TOKEN_ENCRYPTION_KEY. In development a set
  // key is validated; an unset key is tolerated (bank features throw at use).
  assertTokenKeyAtStartup(production);

  app.set("trust proxy", trustProxy());
  // Don't advertise the framework.
  app.disable("x-powered-by");

  app.use(
    pinoHttp({
      logger: options.httpLogger ?? logger,
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
  // one of the exact ALLOWED_ORIGINS. The UI is same-origin
  // behind the shared proxy, so no CORS middleware is needed or wanted.
  app.use(originCheck);
  // Body parsing: the default 100 KB limit applies everywhere EXCEPT the two
  // file-upload endpoints (base64 PDFs/XLSX), which get a scoped larger limit
  // so a huge body cannot be posted to arbitrary routes.
  const defaultJson = express.json();
  const uploadJson = express.json({ limit: "15mb" });
  const UPLOAD_PATHS = /\/(import\/preview|bank\/statement\/extract)$/;
  app.use((req, res, next) =>
    (UPLOAD_PATHS.test(req.path) ? uploadJson : defaultJson)(req, res, next),
  );
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
      cookie: sessionCookieOptions(),
    }),
  );

  app.use(
    "/api",
    createRouter({
      authRateLimitMax: options.authRateLimitMax,
      apiRateLimitMax: options.apiRateLimitMax,
      heavyRateLimitMax: options.heavyRateLimitMax,
      platformResetRateLimitMax: options.platformResetRateLimitMax,
    }),
  );

  if (production) {
    const frontendDir = path.resolve(
      import.meta.dirname,
      "../../books/dist/public",
    );
    app.use(express.static(frontendDir));
    app.get("/{*splat}", (req, res, next) => {
      if (req.path.startsWith("/api")) {
        res.status(404).json({ error: "Not found." });
        return;
      }
      res.sendFile(path.join(frontendDir, "index.html"), (err) => {
        if (err) next(err);
      });
    });
  }

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
      if (isBodyParseError) {
        // Body-parser errors carry the raw request body on `err.body`. Logging
        // the error object would leak passwords and reset tokens.
        req.log?.warn(
          {
            errorType: (err as { type?: string }).type ?? "invalid_json",
            status: 400,
          },
          "Invalid JSON request body",
        );
        res.status(400).json({ error: "Invalid request." });
      } else {
        req.log?.error(
          {
            errorName: err instanceof Error ? err.name : "UnknownError",
          },
          "Unhandled error reached final middleware",
        );
        res.status(500).json({ error: "Internal error." });
      }
    },
  );

  return app;
}

const app = createApp();
export default app;
