/** Minimal in-memory sliding-window rate limiter. Single-instance only. */
interface Bucket {
  hits: number[];
}

const buckets = new Map<string, Bucket>();

export const rateLimit = (key: string, limit: number, windowMs: number, exempt = false): boolean => {
  if (exempt) return true;
  const now = Date.now();
  const bucket = buckets.get(key) ?? { hits: [] };
  bucket.hits = bucket.hits.filter((t) => now - t < windowMs);
  if (bucket.hits.length >= limit) {
    buckets.set(key, bucket);
    return false;
  }
  bucket.hits.push(now);
  buckets.set(key, bucket);
  return true;
};

// Opportunistic cleanup so the map cannot grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.hits.every((t) => now - t > 3_600_000)) buckets.delete(key);
  }
}, 600_000).unref();

/**
 * Resolves the real client IP for rate-limiting. `X-Forwarded-For` is client-writable at the
 * *front* — a script can send `X-Forwarded-For: 1.2.3.4` to try to spread its hits across fake
 * keys. The proxy/infra in front of us appends the actual connecting address, so the trustworthy
 * value is the `depth`-th entry counted from the end (Cloud Run direct = 1). `depth = 0` disables
 * XFF parsing and keys purely on the socket address.
 */
export const clientIp = (
  headers: Record<string, string | string[] | undefined>,
  socketAddr?: string,
  depth = 1
): string => {
  if (depth > 0) {
    const raw = headers["x-forwarded-for"];
    const header = Array.isArray(raw) ? raw.join(",") : raw;
    if (typeof header === "string") {
      const parts = header.split(",").map((s) => s.trim()).filter(Boolean);
      if (parts.length) return parts[Math.max(0, parts.length - depth)]!;
    }
  }
  return socketAddr ?? "unknown";
};
