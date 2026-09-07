import type { IncomingMessage, ServerResponse } from "node:http";
import { env } from "./env.js";
import { verifyToken, type Claims } from "./jwt.js";
import { clientIp } from "./ratelimit.js";

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  body: unknown;
  claims: Claims | null;
  ip: string;
}

export type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export const json = (res: ServerResponse, status: number, payload: unknown): void => {
  const data = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": env.corsOrigin,
    "access-control-allow-headers": "content-type,authorization",
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS"
  });
  res.end(data);
};

const compile = (path: string): { pattern: RegExp; keys: string[] } => {
  const keys: string[] = [];
  const pattern = path.replace(/:[^/]+/g, (m) => {
    keys.push(m.slice(1));
    return "([^/]+)";
  });
  return { pattern: new RegExp(`^${pattern}$`), keys };
};

export class Router {
  private routes: Route[] = [];

  add(method: string, path: string, handler: Handler): this {
    const { pattern, keys } = compile(path);
    this.routes.push({ method, pattern, keys, handler });
    return this;
  }

  get = (p: string, h: Handler) => this.add("GET", p, h);
  post = (p: string, h: Handler) => this.add("POST", p, h);
  patch = (p: string, h: Handler) => this.add("PATCH", p, h);
  delete = (p: string, h: Handler) => this.add("DELETE", p, h);

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (req.method === "OPTIONS") {
      json(res, 204, {});
      return true;
    }
    for (const route of this.routes) {
      if (route.method !== req.method) continue;
      const match = route.pattern.exec(url.pathname);
      if (!match) continue;

      const params: Record<string, string> = {};
      route.keys.forEach((key, i) => (params[key] = decodeURIComponent(match[i + 1])));

      const auth = req.headers.authorization;
      const claims = auth?.startsWith("Bearer ") ? verifyToken(auth.slice(7)) : null;

      let body: unknown;
      if (req.method === "POST" || req.method === "PATCH") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const raw = Buffer.concat(chunks).toString("utf8");
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          json(res, 400, { error: "Invalid JSON body." });
          return true;
        }
      }

      try {
        const ip = clientIp(req.headers, req.socket.remoteAddress ?? undefined, env.trustedProxyDepth);
        const result = await route.handler({ req, res, url, params, body, claims, ip });
        if (!res.writableEnded) json(res, 200, result ?? {});
      } catch (error) {
        if (error instanceof HttpError) json(res, error.status, { error: error.message });
        else {
          console.error("Request failed:", error);
          json(res, 500, { error: "Internal error." });
        }
      }
      return true;
    }
    return false;
  }
}

export const requireUser = (ctx: Ctx): { userId: string; email: string } => {
  if (!ctx.claims || ctx.claims.typ !== "user") throw new HttpError(401, "Authentication required.");
  return { userId: ctx.claims.sub, email: ctx.claims.email };
};
