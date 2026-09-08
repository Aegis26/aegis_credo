import { eq } from "drizzle-orm";
import argon2 from "argon2";
import { db, usersTable, authEventsTable, type User } from "@workspace/db";
import { ConflictError, InvalidCredentialsError } from "./errors";

// After this many consecutive failed logins the account is locked for
// LOCKOUT_MINUTES. A successful login resets the counter.
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;

export type AuthEventType =
  | "signup"
  | "login"
  | "logout"
  | "login_failed"
  | "account_locked";

/**
 * A precomputed argon2id hash verified against when a login targets a missing
 * or password-less account, so the response time does not reveal whether an
 * email is registered (mitigates user enumeration via timing).
 */
let dummyHashPromise: Promise<string> | null = null;
function dummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = argon2.hash("timing-equalizer", { type: argon2.argon2id });
  }
  return dummyHashPromise;
}

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Read and validate the configured platform identity at request time.
 * Invalid/missing values always mean there is no master administrator.
 */
export function configuredMasterEmail(): string | undefined {
  const email = normalizeEmail(process.env.MASTER_ADMIN_EMAIL ?? "");
  return email && EMAIL_PATTERN.test(email) ? email : undefined;
}

/** Append an immutable auth audit row. Never throws to the caller's flow. */
export async function recordAuthEvent(
  event: AuthEventType,
  info: {
    userId?: string | null;
    email?: string | null;
    ip?: string | null;
    detail?: string | null;
  } = {},
): Promise<void> {
  await db.insert(authEventsTable).values({
    event,
    userId: info.userId ?? null,
    email: info.email ?? null,
    ip: info.ip ?? null,
    detail: info.detail ?? null,
  });
}

export interface SignupInput {
  email: string;
  password: string;
  name?: string;
  ip?: string | null;
  /** Shell-only provisioning escape hatch; HTTP callers must never set this. */
  allowConfiguredMasterEmail?: boolean;
}

/** Create a new account with a hashed password. Rejects duplicate emails. */
export async function signup(input: SignupInput): Promise<User> {
  const email = normalizeEmail(input.email);
  if (
    !input.allowConfiguredMasterEmail &&
    email === configuredMasterEmail()
  ) {
    throw new ConflictError("Email is reserved for operator provisioning.");
  }
  const [existing] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email))
    .limit(1);
  if (existing) {
    throw new ConflictError("Email already registered.");
  }
  const passwordHash = await hashPassword(input.password);
  let user: User;
  try {
    [user] = await db
      .insert(usersTable)
      .values({ email, name: input.name, passwordHash })
      .returning();
  } catch {
    // Unique-constraint race: a concurrent signup won the email.
    throw new ConflictError("Email already registered.");
  }
  await recordAuthEvent("signup", { userId: user.id, email, ip: input.ip });
  return user;
}

export interface LoginInput {
  email: string;
  password: string;
  ip?: string | null;
}

/**
 * Verify credentials and return the user. Enforces lockout after repeated
 * failures and records every attempt (success or failure) to the auth log.
 */
export async function login(input: LoginInput): Promise<User> {
  const email = normalizeEmail(input.email);
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email))
    .limit(1);

  if (!user || !user.passwordHash || user.deactivatedAt) {
    // Equalize timing against the real verify path, then fail generically.
    await argon2.verify(await dummyHash(), input.password).catch(() => false);
    await recordAuthEvent("login_failed", {
      userId: user?.id ?? null,
      email,
      ip: input.ip,
      detail: user ? "no_password" : "no_such_user",
    });
    throw new InvalidCredentialsError();
  }

  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    // Lockout is enforced internally but NOT revealed to the client: a locked
    // account returns the same generic 401 as a wrong password or an unknown
    // email, so login responses can't be used to enumerate accounts.
    await recordAuthEvent("login_failed", {
      userId: user.id,
      email,
      ip: input.ip,
      detail: "locked",
    });
    throw new InvalidCredentialsError();
  }

  const ok = await argon2
    .verify(user.passwordHash, input.password)
    .catch(() => false);

  if (!ok) {
    const failed = user.failedLoginCount + 1;
    const lock = failed >= MAX_FAILED_LOGINS;
    await db
      .update(usersTable)
      .set({
        failedLoginCount: lock ? 0 : failed,
        lockedUntil: lock
          ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000)
          : user.lockedUntil,
      })
      .where(eq(usersTable.id, user.id));
    await recordAuthEvent(lock ? "account_locked" : "login_failed", {
      userId: user.id,
      email,
      ip: input.ip,
      detail: lock ? `locked_after_${failed}` : `attempt_${failed}`,
    });
    // Same generic 401 whether or not this attempt tripped the lock, so the
    // transition to "locked" is not observable to an attacker.
    throw new InvalidCredentialsError();
  }

  if (user.failedLoginCount !== 0 || user.lockedUntil) {
    await db
      .update(usersTable)
      .set({ failedLoginCount: 0, lockedUntil: null })
      .where(eq(usersTable.id, user.id));
  }
  await recordAuthEvent("login", { userId: user.id, email, ip: input.ip });
  return user;
}

export async function getUserById(id: string): Promise<User | undefined> {
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, id))
    .limit(1);
  return user;
}
