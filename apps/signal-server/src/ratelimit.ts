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

export const clientIp = (headers: Record<string, string | string[] | undefined>, socketAddr?: string): string => {
  const forwarded = headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0]!.trim();
  if (Array.isArray(forwarded) && forwarded[0]) return forwarded[0].split(",")[0]!.trim();
  return socketAddr ?? "unknown";
};
