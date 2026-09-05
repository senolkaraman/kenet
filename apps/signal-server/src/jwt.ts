import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "./env.js";

const b64url = (input: Buffer | string): string =>
  Buffer.from(input).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

const b64urlJson = (value: unknown): string => b64url(JSON.stringify(value));

const fromB64url = (input: string): Buffer =>
  Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/"), "base64");

export interface UserClaims {
  typ: "user";
  sub: string; // user id
  email: string;
}

export interface DeviceClaims {
  typ: "device";
  sub: string; // device id
  uid: string; // owning user id
}

export interface UnattendedClaims {
  typ: "unattended";
  sub: string; // target device id
  by: string; // controlling user id
}

/** Issued after a correct password when TOTP is enabled — proves "who", not "logged in yet". */
export interface TotpPendingClaims {
  typ: "totp-pending";
  sub: string; // user id
}

export type Claims = (UserClaims | DeviceClaims | UnattendedClaims | TotpPendingClaims) & { iat: number; exp: number };

const sign = (payload: Record<string, unknown>, ttlSeconds: number): string => {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttlSeconds };
  const header = b64urlJson({ alg: "HS256", typ: "JWT" });
  const claims = b64urlJson(body);
  const signature = b64url(createHmac("sha256", env.jwtSecret).update(`${header}.${claims}`).digest());
  return `${header}.${claims}.${signature}`;
};

export const signUserToken = (user: { id: string; email: string }): string =>
  sign({ typ: "user", sub: user.id, email: user.email }, env.userTokenTtlSeconds);

export const signDeviceToken = (device: { id: string; userId: string }): string =>
  sign({ typ: "device", sub: device.id, uid: device.userId }, env.deviceTokenTtlSeconds);

/** Short-lived one-shot ticket proving an unattended password was verified for a device. */
export const signUnattendedTicket = (deviceId: string, byUserId: string): string =>
  sign({ typ: "unattended", sub: deviceId, by: byUserId }, 90);

/** Proves the password step passed; the holder still needs a valid TOTP/recovery code. */
export const signTotpPending = (userId: string): string => sign({ typ: "totp-pending", sub: userId }, 5 * 60);

export const verifyToken = (token: string): Claims | null => {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, claims, signature] = parts;
  const expected = createHmac("sha256", env.jwtSecret).update(`${header}.${claims}`).digest();
  const provided = fromB64url(signature);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  try {
    const parsed = JSON.parse(fromB64url(claims).toString("utf8")) as Claims;
    if (typeof parsed.exp !== "number" || parsed.exp < Math.floor(Date.now() / 1000)) return null;
    if (parsed.typ !== "user" && parsed.typ !== "device" && parsed.typ !== "unattended" && parsed.typ !== "totp-pending") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};
