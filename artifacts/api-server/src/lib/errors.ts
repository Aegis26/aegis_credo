import type { Response } from "express";
import { ZodError } from "zod";
import {
  ForbiddenError,
  NotFoundError,
  InvalidEntryError,
  InvalidLineError,
  UnbalancedEntryError,
  ImportError,
} from "@workspace/ledger";

/**
 * Base class for errors that carry an explicit HTTP status. Auth/identity
 * concerns live at the API boundary (the ledger core has no notion of HTTP),
 * so they are modeled here rather than in the library.
 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** No valid session was presented. */
export class UnauthorizedError extends HttpError {
  constructor(message = "Authentication required.") {
    super(401, message);
  }
}

/**
 * Login failed. Deliberately identical whether the email is unknown or the
 * password is wrong, so responses do not leak which emails are registered.
 */
export class InvalidCredentialsError extends HttpError {
  constructor(message = "Invalid email or password.") {
    super(401, message);
  }
}

/** Signup collided with an existing account. */
export class ConflictError extends HttpError {
  constructor(message = "Conflict.") {
    super(409, message);
  }
}

/**
 * Map a thrown error to an HTTP response. Explicit HttpErrors win first; then
 * the typed ledger/validation errors are translated into status codes with a
 * uniform `{ error }` body.
 */
export function sendLedgerError(res: Response, err: unknown): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof ForbiddenError) {
    res.status(403).json({ error: err.message });
    return;
  }
  if (err instanceof NotFoundError) {
    res.status(404).json({ error: err.message });
    return;
  }
  if (
    err instanceof ZodError ||
    err instanceof InvalidEntryError ||
    err instanceof InvalidLineError ||
    err instanceof UnbalancedEntryError ||
    err instanceof ImportError
  ) {
    const message = err instanceof ZodError ? "Invalid request." : err.message;
    res.status(400).json({ error: message });
    return;
  }
  const message = err instanceof Error ? err.message : "Internal error.";
  res.status(500).json({ error: message });
}
