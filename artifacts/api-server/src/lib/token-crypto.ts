import crypto from "node:crypto";

/**
 * AES-256-GCM encryption-at-rest for third-party credentials (Plaid access
 * tokens). Key comes from the TOKEN_ENCRYPTION_KEY secret: 32 random bytes,
 * base64-encoded.
 *
 * Wire format (single string, stored in the existing text column):
 *   v1:<iv b64>:<ciphertext b64>:<authTag b64>
 *
 * - A FRESH random 12-byte IV is generated per encryption (GCM nonces must
 *   never repeat under one key).
 * - The GCM auth tag is verified on decrypt; tampering throws loudly.
 * - The plaintext token and the key are never logged.
 */

const PREFIX = "v1:";
const IV_BYTES = 12;
const KEY_BYTES = 32;

export class TokenCryptoError extends Error {}

/** Parse + validate the key. Throws on missing/malformed input. */
export function parseTokenKey(raw: string | undefined): Buffer {
  if (!raw) {
    throw new TokenCryptoError("TOKEN_ENCRYPTION_KEY is not set.");
  }
  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    throw new TokenCryptoError("TOKEN_ENCRYPTION_KEY is not valid base64.");
  }
  if (key.length !== KEY_BYTES) {
    throw new TokenCryptoError(
      `TOKEN_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes (got ${key.length}). Generate with: openssl rand -base64 32`,
    );
  }
  return key;
}

/**
 * FAIL CLOSED at startup, mirroring SESSION_SECRET: in production a missing or
 * malformed key refuses to boot. In development the check only runs when the
 * key is set (so a keyless dev env can still run non-bank features), but any
 * encrypt/decrypt call without a valid key still throws.
 */
export function assertTokenKeyAtStartup(isProduction: boolean): void {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw && !isProduction) return;
  parseTokenKey(raw); // throws TokenCryptoError on missing/malformed
}

function getKey(): Buffer {
  return parseTokenKey(process.env.TOKEN_ENCRYPTION_KEY);
}

export function isEncryptedToken(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function encryptToken(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_BYTES); // fresh nonce per encryption
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${ciphertext.toString("base64")}:${tag.toString("base64")}`;
}

/**
 * Decrypt a stored token. Accepts legacy plaintext (no "v1:" prefix) so the
 * app keeps working until the one-time migration has run; encrypted values
 * MUST authenticate or this throws (tamper detection).
 */
export function decryptToken(stored: string): string {
  if (!isEncryptedToken(stored)) return stored; // legacy plaintext row
  const parts = stored.slice(PREFIX.length).split(":");
  if (parts.length !== 3) {
    throw new TokenCryptoError("Malformed encrypted token envelope.");
  }
  const [ivB64, ctB64, tagB64] = parts;
  const key = getKey();
  const iv = Buffer.from(ivB64, "base64");
  const ciphertext = Buffer.from(ctB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  if (iv.length !== IV_BYTES) {
    throw new TokenCryptoError("Malformed encrypted token IV.");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
      "utf8",
    );
  } catch {
    // GCM auth failed: wrong key or tampered ciphertext. Fail loudly, reveal
    // nothing about the payload.
    throw new TokenCryptoError(
      "Token decryption failed authentication (wrong key or tampered data).",
    );
  }
}
