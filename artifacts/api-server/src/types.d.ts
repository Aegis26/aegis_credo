import "express-session";

// The authenticated identity lives on the session, set server-side at login and
// never accepted from the client. `req.userId` is a convenience copy attached by
// the requireAuth middleware after it verifies the session.
declare module "express-session" {
  interface SessionData {
    userId?: string;
  }
}

declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export {};
