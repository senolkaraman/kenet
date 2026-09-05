import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Hand-rolled RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30s step) — same house style as jwt.ts/password.ts:
// no external auth dependency for a primitive this small and this security-sensitive.

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** A fresh 160-bit secret (RFC 4226's recommended HMAC-SHA1 key length), base32-encoded. */
export const generateTotpSecret = (): string => {
  const bytes = randomBytes(20);
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  let secret = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) secret += BASE32_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  return secret;
};

const base32Decode = (input: string): Buffer => {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const c of clean) {
    const value = BASE32_ALPHABET.indexOf(c);
    if (value < 0) continue;
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
};

const hotp = (key: Buffer, counter: number): string => {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (code % 1_000_000).toString().padStart(6, "0");
};

/** The code a real authenticator app would show right now — exported mainly so tests can compute
 *  a valid code without duplicating the HOTP math (nothing server-side calls this in production). */
export const currentTotpCode = (secret: string): string =>
  hotp(base32Decode(secret), Math.floor(Date.now() / 1000 / 30));

/** Accepts the current 30s step and one step of drift either way (~90s window total). */
export const verifyTotpCode = (secret: string, code: string): boolean => {
  if (!/^\d{6}$/.test(code)) return false;
  const key = base32Decode(secret);
  const counter = Math.floor(Date.now() / 1000 / 30);
  for (const drift of [0, -1, 1]) {
    const expected = hotp(key, counter + drift);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(code))) return true;
  }
  return false;
};

export const otpauthUrl = (email: string, secret: string): string =>
  `otpauth://totp/Kenet:${encodeURIComponent(email)}?secret=${secret}&issuer=Kenet&digits=6&period=30`;

/** One-time recovery codes shown once at enrollment, for when the authenticator app is lost. */
export const generateRecoveryCodes = (count = 8): string[] => {
  const codes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const raw = randomBytes(5).toString("hex").toUpperCase();
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5, 10)}`);
  }
  return codes;
};
