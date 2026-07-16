import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import {
  encryptToken,
  decryptToken,
  isEncryptedToken,
  parseTokenKey,
  assertTokenKeyAtStartup,
  TokenCryptoError,
} from "./token-crypto";

const ORIGINAL = process.env.TOKEN_ENCRYPTION_KEY;
const TEST_KEY = crypto.randomBytes(32).toString("base64");

beforeAll(() => {
  process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY;
});

afterAll(() => {
  if (ORIGINAL === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
  else process.env.TOKEN_ENCRYPTION_KEY = ORIGINAL;
});

describe("token-crypto", () => {
  it("round-trips a token (encrypt on write, decrypt on read)", () => {
    const token = "access-sandbox-12345-abcdef";
    const stored = encryptToken(token);
    expect(stored.startsWith("v1:")).toBe(true);
    expect(stored).not.toContain(token);
    expect(decryptToken(stored)).toBe(token);
  });

  it("uses a fresh IV per encryption (same plaintext -> different ciphertext)", () => {
    const a = encryptToken("same-token");
    const b = encryptToken("same-token");
    expect(a).not.toBe(b);
    expect(decryptToken(a)).toBe("same-token");
    expect(decryptToken(b)).toBe("same-token");
  });

  it("detects tampering: flipped ciphertext byte fails auth loudly", () => {
    const stored = encryptToken("secret-token");
    const [prefix, iv, ct, tag] = [
      stored.slice(0, 3),
      ...stored.slice(3).split(":"),
    ];
    const ctBuf = Buffer.from(ct, "base64");
    ctBuf[0] ^= 0xff;
    const tampered = `${prefix}${iv}:${ctBuf.toString("base64")}:${tag}`;
    expect(() => decryptToken(tampered)).toThrow(TokenCryptoError);
  });

  it("detects tampering: modified auth tag fails", () => {
    const stored = encryptToken("secret-token");
    const parts = stored.slice(3).split(":");
    const tagBuf = Buffer.from(parts[2], "base64");
    tagBuf[0] ^= 0x01;
    const tampered = `v1:${parts[0]}:${parts[1]}:${tagBuf.toString("base64")}`;
    expect(() => decryptToken(tampered)).toThrow(TokenCryptoError);
  });

  it("rejects decryption under a different key", () => {
    const stored = encryptToken("secret-token");
    process.env.TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
    try {
      expect(() => decryptToken(stored)).toThrow(TokenCryptoError);
    } finally {
      process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY;
    }
  });

  it("passes legacy plaintext through unchanged (pre-migration rows)", () => {
    expect(decryptToken("access-sandbox-legacy-plaintext")).toBe(
      "access-sandbox-legacy-plaintext",
    );
    expect(isEncryptedToken("access-sandbox-legacy-plaintext")).toBe(false);
  });

  it("parseTokenKey fails closed on missing/malformed keys", () => {
    expect(() => parseTokenKey(undefined)).toThrow(TokenCryptoError);
    expect(() => parseTokenKey("")).toThrow(TokenCryptoError);
    expect(() => parseTokenKey("too-short")).toThrow(TokenCryptoError);
    expect(() =>
      parseTokenKey(Buffer.alloc(16).toString("base64")),
    ).toThrow(TokenCryptoError); // 16 bytes, not 32
    expect(parseTokenKey(TEST_KEY).length).toBe(32);
  });

  it("assertTokenKeyAtStartup: production refuses missing or malformed key", () => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    expect(() => assertTokenKeyAtStartup(true)).toThrow(TokenCryptoError);
    process.env.TOKEN_ENCRYPTION_KEY = "not-a-real-key";
    expect(() => assertTokenKeyAtStartup(true)).toThrow(TokenCryptoError);
    // Dev without a key: allowed to boot (bank features still gated at call time).
    delete process.env.TOKEN_ENCRYPTION_KEY;
    expect(() => assertTokenKeyAtStartup(false)).not.toThrow();
    process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY;
    expect(() => assertTokenKeyAtStartup(true)).not.toThrow();
  });
});
