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
 * Map a thrown ledger/validation error to an HTTP response. The ledger core is
 * a plain library that throws typed errors; the API boundary translates them
 * into status codes and a uniform `{ error }` body.
 */
export function sendLedgerError(res: Response, err: unknown): void {
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
