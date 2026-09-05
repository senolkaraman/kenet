import { createHash, randomBytes } from "node:crypto";
import type { AuthResponse, AuthUser, LoginResult, TotpEnableResult, TotpSetup } from "@kenet/protocol";
import { query } from "./db.js";
import { hashPassword, verifyPassword } from "./password.js";
import { signTotpPending, signUserToken, verifyToken } from "./jwt.js";
import { HttpError, requireUser, type Ctx } from "./http.js";
import { rateLimit } from "./ratelimit.js";
import { resolvePlan } from "./plans.js";
import { sendPasswordResetEmail } from "./email.js";
import { generateRecoveryCodes, generateTotpSecret, otpauthUrl, verifyTotpCode } from "./totp.js";

export const buildUser = async (id: string, email: string): Promise<AuthUser> => {
  const p = await resolvePlan(id);
  const row = (await query<{ totp_enabled: boolean }>("select totp_enabled from users where id = $1", [id])).rows[0];
  return {
    id,
    email,
    plan: p.plan,
    planRenewsAt: p.planRenewsAt,
    orgId: p.orgId,
    orgRole: p.orgRole,
    totpEnabled: row?.totp_enabled ?? false
  };
};

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const throttle = (ctx: Ctx, action: string, limit: number, windowMs: number): void => {
  if (!rateLimit(`${action}:${ctx.ip}`, limit, windowMs)) {
    throw new HttpError(429, "Çok fazla deneme. Birkaç dakika sonra tekrar deneyin.");
  }
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  totp_secret?: string | null;
  totp_enabled?: boolean;
  totp_recovery_hashes?: string[];
}

const readCredentials = (body: unknown): { email: string; password: string } => {
  const { email, password } = (body ?? {}) as { email?: unknown; password?: unknown };
  if (typeof email !== "string" || !EMAIL_RE.test(email.trim())) throw new HttpError(400, "Geçerli bir e-posta girin.");
  if (typeof password !== "string" || password.length < 8) throw new HttpError(400, "Şifre en az 8 karakter olmalı.");
  return { email: email.trim().toLowerCase(), password };
};

export const registerHandler = async (ctx: Ctx): Promise<AuthResponse> => {
  // 10/hour per IP — enough for a household/small office setting up several machines in one sitting,
  // still tight enough to blunt automated signup abuse.
  throttle(ctx, "register", 10, 60 * 60 * 1000);
  const { email, password } = readCredentials(ctx.body);
  const existing = await query<UserRow>("select id from users where email = $1", [email]);
  if (existing.rowCount) throw new HttpError(409, "Bu e-posta zaten kayıtlı.");

  const passwordHash = await hashPassword(password);
  const inserted = await query<UserRow>(
    "insert into users (email, password_hash) values ($1, $2) returning id, email",
    [email, passwordHash]
  );
  const user = inserted.rows[0];
  return { token: signUserToken(user), user: await buildUser(user.id, user.email) };
};

export const loginHandler = async (ctx: Ctx): Promise<LoginResult> => {
  throttle(ctx, "login", 10, 15 * 60 * 1000);
  const { email, password } = readCredentials(ctx.body);
  const found = await query<UserRow>(
    "select id, email, password_hash, totp_enabled from users where email = $1",
    [email]
  );
  const user = found.rows[0];
  const ok = user ? await verifyPassword(password, user.password_hash) : false;
  if (!user || !ok) throw new HttpError(401, "E-posta veya şifre hatalı.");
  if (user.totp_enabled) return { requiresTotp: true, pendingToken: signTotpPending(user.id) };
  return { token: signUserToken(user), user: await buildUser(user.id, user.email) };
};

/** Step 2 of login when TOTP is enabled: a 6-digit app code, or a one-time recovery code. */
export const totpVerifyHandler = async (ctx: Ctx): Promise<AuthResponse> => {
  throttle(ctx, "totp-verify", 8, 5 * 60 * 1000);
  const { pendingToken, code } = (ctx.body ?? {}) as { pendingToken?: unknown; code?: unknown };
  if (typeof pendingToken !== "string" || typeof code !== "string" || !code.trim()) {
    throw new HttpError(400, "Kod gerekli.");
  }
  const claims = verifyToken(pendingToken);
  if (!claims || claims.typ !== "totp-pending") throw new HttpError(401, "Oturum süresi doldu, tekrar giriş yapın.");

  const user = (
    await query<UserRow>("select id, email, totp_secret, totp_recovery_hashes from users where id = $1", [claims.sub])
  ).rows[0];
  if (!user || !user.totp_secret) throw new HttpError(401, "Geçersiz istek.");

  const trimmed = code.trim();
  if (/^\d{6}$/.test(trimmed) && verifyTotpCode(user.totp_secret, trimmed)) {
    return { token: signUserToken(user), user: await buildUser(user.id, user.email) };
  }

  // Not a valid app code — try it as a one-time recovery code instead.
  const hashes = user.totp_recovery_hashes ?? [];
  for (let i = 0; i < hashes.length; i += 1) {
    if (await verifyPassword(trimmed.toUpperCase(), hashes[i])) {
      const remaining = [...hashes.slice(0, i), ...hashes.slice(i + 1)];
      await query("update users set totp_recovery_hashes = $1 where id = $2", [remaining, user.id]);
      return { token: signUserToken(user), user: await buildUser(user.id, user.email) };
    }
  }
  throw new HttpError(401, "Kod hatalı.");
};

/** Starts (or restarts) enrollment: issues a fresh secret, not yet enabled until confirmed. */
export const totpSetupHandler = async (ctx: Ctx): Promise<TotpSetup> => {
  const { userId, email } = requireUser(ctx);
  throttle(ctx, "totp-setup", 10, 15 * 60 * 1000);
  const secret = generateTotpSecret();
  await query("update users set totp_secret = $1, totp_enabled = false where id = $2", [secret, userId]);
  return { secret, otpauthUrl: otpauthUrl(email, secret) };
};

/** Confirms enrollment with one real code from the app, then turns TOTP on for the account. */
export const totpEnableHandler = async (ctx: Ctx): Promise<TotpEnableResult> => {
  const { userId } = requireUser(ctx);
  throttle(ctx, "totp-enable", 10, 15 * 60 * 1000);
  const { code } = (ctx.body ?? {}) as { code?: unknown };
  if (typeof code !== "string") throw new HttpError(400, "Kod gerekli.");

  const row = (await query<{ totp_secret: string | null }>("select totp_secret from users where id = $1", [userId]))
    .rows[0];
  if (!row?.totp_secret) throw new HttpError(400, "Önce kurulum başlatılmalı.");
  if (!verifyTotpCode(row.totp_secret, code.trim())) throw new HttpError(401, "Kod hatalı.");

  const recoveryCodes = generateRecoveryCodes();
  const hashes = await Promise.all(recoveryCodes.map((c) => hashPassword(c)));
  await query("update users set totp_enabled = true, totp_recovery_hashes = $1 where id = $2", [hashes, userId]);
  return { recoveryCodes };
};

/** Turns TOTP back off — requires the current password as a safety check. */
export const totpDisableHandler = async (ctx: Ctx): Promise<{ ok: true }> => {
  const { userId } = requireUser(ctx);
  const { password } = (ctx.body ?? {}) as { password?: unknown };
  if (typeof password !== "string") throw new HttpError(400, "Şifre gerekli.");

  const row = (await query<UserRow>("select password_hash from users where id = $1", [userId])).rows[0];
  if (!row || !(await verifyPassword(password, row.password_hash))) throw new HttpError(401, "Şifre hatalı.");

  await query(
    "update users set totp_enabled = false, totp_secret = null, totp_recovery_hashes = '{}' where id = $1",
    [userId]
  );
  return { ok: true };
};

/**
 * Also returns a freshly-signed token (same user, full new TTL) — a sliding session. The client
 * stores this back over its old token on every call, so a single-owner desktop app effectively
 * never has to log in again as long as it's opened at least once within the TTL window.
 */
export const meHandler = async (ctx: Ctx): Promise<{ user: AuthUser; token: string }> => {
  const { userId, email } = requireUser(ctx);
  return { user: await buildUser(userId, email), token: signUserToken({ id: userId, email }) };
};

/**
 * Starts a password reset. Always returns { ok: true } so callers cannot probe which
 * emails exist. TODO(email): deliver the link by email instead of logging it.
 */
export const forgotHandler = async (ctx: Ctx): Promise<{ ok: true }> => {
  throttle(ctx, "forgot", 5, 60 * 60 * 1000);
  const { email } = (ctx.body ?? {}) as { email?: unknown };
  if (typeof email !== "string" || !EMAIL_RE.test(email.trim())) return { ok: true };

  const user = (await query<{ id: string }>("select id from users where email = $1", [email.trim().toLowerCase()]))
    .rows[0];
  if (user) {
    const token = randomBytes(32).toString("hex");
    await query("delete from password_resets where user_id = $1", [user.id]);
    await query(
      "insert into password_resets (token_hash, user_id, expires_at) values ($1, $2, now() + interval '1 hour')",
      [sha256(token), user.id]
    );
    const target = email.trim().toLowerCase();
    const sent = await sendPasswordResetEmail(target, token);
    if (!sent) console.log(`[password-reset] ${target} -> token ${token}`);
  }
  return { ok: true };
};

export const resetHandler = async (ctx: Ctx): Promise<AuthResponse> => {
  throttle(ctx, "reset", 10, 60 * 60 * 1000);
  const { token, password } = (ctx.body ?? {}) as { token?: unknown; password?: unknown };
  if (typeof token !== "string" || !token) throw new HttpError(400, "Geçersiz bağlantı.");
  if (typeof password !== "string" || password.length < 8) throw new HttpError(400, "Şifre en az 8 karakter olmalı.");

  const row = (
    await query<{ user_id: string; expires_at: Date }>(
      "select user_id, expires_at from password_resets where token_hash = $1",
      [sha256(token)]
    )
  ).rows[0];
  if (!row || row.expires_at.getTime() < Date.now()) throw new HttpError(400, "Bağlantının süresi dolmuş.");

  const passwordHash = await hashPassword(password);
  await query("update users set password_hash = $1 where id = $2", [passwordHash, row.user_id]);
  await query("delete from password_resets where user_id = $1", [row.user_id]);

  const user = (await query<UserRow>("select id, email from users where id = $1", [row.user_id])).rows[0];
  return { token: signUserToken(user), user: await buildUser(user.id, user.email) };
};
