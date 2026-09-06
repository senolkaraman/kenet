const required = (name: string, fallback?: string): string => {
  const value = process.env[name]?.trim() || fallback;
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

export const env = {
  port: Number(process.env.PORT ?? 8787),
  /** Postgres connection string, e.g. postgresql://user:pass@host:5432/db or a Cloud SQL unix socket URL. */
  databaseUrl: process.env.DATABASE_URL?.trim() ?? "",
  jwtSecret: required("JWT_SECRET", process.env.NODE_ENV === "production" ? undefined : "dev-insecure-secret"),
  // A single-owner desktop app should stay logged in until the user explicitly logs out — the
  // client silently renews this on every /auth/me call (see meHandler), so in practice a session
  // only actually expires if the app goes unopened for the whole window below.
  userTokenTtlSeconds: Number(process.env.USER_TOKEN_TTL ?? 60 * 60 * 24 * 90),
  deviceTokenTtlSeconds: Number(process.env.DEVICE_TOKEN_TTL ?? 60 * 60 * 24 * 180),
  turnUrl: process.env.TURN_URL?.trim() ?? "",
  turnSharedSecret: process.env.TURN_SHARED_SECRET?.trim() ?? "",
  // Pre-shared TURN creds — for a free community/managed TURN that doesn't do HMAC time-limited
  // credentials (e.g. Open Relay). Takes priority over the HMAC path when all three are set.
  turnStaticUrls: (process.env.TURN_STATIC_URLS?.trim() ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  turnStaticUsername: process.env.TURN_STATIC_USERNAME?.trim() ?? "",
  turnStaticCredential: process.env.TURN_STATIC_CREDENTIAL?.trim() ?? "",
  corsOrigin: process.env.CORS_ORIGIN?.trim() ?? "*",
  publicUrl: (process.env.PUBLIC_URL?.trim() ?? "").replace(/\/$/, ""),
  // Accounts always treated as operators — bypass limits, see the admin panel. The operator's
  // own account, so they never rate-limit themselves while testing.
  adminEmails: (process.env.ADMIN_EMAILS?.trim() ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  // IPs exempt from the pre-auth (IP-keyed) throttles — the operator's home/office IP.
  rateLimitExemptIps: (process.env.RATELIMIT_EXEMPT_IPS?.trim() ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  resend: {
    apiKey: process.env.RESEND_API_KEY?.trim() ?? "",
    from: process.env.EMAIL_FROM?.trim() || "Kenet <onboarding@resend.dev>"
  },
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY?.trim() ?? "",
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET?.trim() ?? "",
    pricePro: process.env.STRIPE_PRICE_PRO?.trim() ?? "",
    priceTeam: process.env.STRIPE_PRICE_TEAM?.trim() ?? ""
  }
};

export const billingEnabled = (): boolean => Boolean(env.stripe.secretKey && env.stripe.pricePro);
