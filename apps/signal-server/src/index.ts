import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { WebSocketServer } from "ws";
import { env } from "./env.js";
import { migrate } from "./db.js";
import { Router, json } from "./http.js";
import { verifyToken } from "./jwt.js";
import {
  forgotHandler,
  loginHandler,
  meHandler,
  registerHandler,
  resetHandler,
  totpDisableHandler,
  totpEnableHandler,
  totpSetupHandler,
  totpVerifyHandler
} from "./auth.js";
import {
  deleteDeviceHandler,
  listDevicesHandler,
  patchDeviceHandler,
  registerDeviceHandler,
  rotateDeviceHandler,
  unattendedTicketHandler,
  wakeDeviceHandler
} from "./devices.js";
import { listActivityHandler, logEventHandler } from "./activity.js";
import { checkoutHandler, handleWebhookEvent, portalHandler } from "./billing.js";
import {
  acceptInviteHandler,
  inviteHandler,
  listMembersHandler,
  listOrgsHandler,
  pendingInvitesHandler,
  removeMemberHandler
} from "./orgs.js";
import { handleConnection } from "./signaling.js";

const api = new Router()
  .post("/auth/register", registerHandler)
  .post("/auth/login", loginHandler)
  .post("/auth/forgot", forgotHandler)
  .post("/auth/reset", resetHandler)
  .post("/auth/totp/verify", totpVerifyHandler)
  .post("/auth/totp/setup", totpSetupHandler)
  .post("/auth/totp/enable", totpEnableHandler)
  .post("/auth/totp/disable", totpDisableHandler)
  .get("/auth/me", meHandler)
  .get("/devices", listDevicesHandler)
  .post("/devices", registerDeviceHandler)
  .post("/devices/:id/unattended-ticket", unattendedTicketHandler)
  .post("/devices/:id/rotate", rotateDeviceHandler)
  .post("/devices/:id/wake", wakeDeviceHandler)
  .patch("/devices/:id", patchDeviceHandler)
  .delete("/devices/:id", deleteDeviceHandler)
  .post("/activity", logEventHandler)
  .get("/activity", listActivityHandler)
  .post("/billing/checkout", checkoutHandler)
  .post("/billing/portal", portalHandler)
  .get("/orgs", listOrgsHandler)
  .get("/orgs/:id/members", listMembersHandler)
  .post("/orgs/:id/invites", inviteHandler)
  .delete("/orgs/:id/members/:userId", removeMemberHandler)
  .get("/invites", pendingInvitesHandler)
  .post("/invites/:id/accept", acceptInviteHandler);

const turnCredentials = (res: Parameters<typeof json>[0], token: string | undefined): void => {
  const hasStatic = env.turnStaticUrls.length > 0 && env.turnStaticUsername && env.turnStaticCredential;
  if (!hasStatic && (!env.turnUrl || !env.turnSharedSecret)) {
    json(res, 503, { error: "TURN is not configured." });
    return;
  }
  if (!token || !verifyToken(token)) {
    json(res, 401, { error: "Unauthorized." });
    return;
  }
  if (hasStatic) {
    json(res, 200, {
      iceServers: [
        { urls: env.turnStaticUrls, username: env.turnStaticUsername, credential: env.turnStaticCredential }
      ]
    });
    return;
  }
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const username = `${expiresAt}:kenet`;
  const credential = createHmac("sha1", env.turnSharedSecret).update(username).digest("base64");
  json(res, 200, { iceServers: [{ urls: env.turnUrl, username, credential }] });
};

const readRawBody = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });

const RETURN_PAGE = (ok: boolean) => `<!doctype html><html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kenet</title><style>body{font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#0d1014;color:#eef2f6}
.c{text-align:center;max-width:340px;padding:32px}h1{font-size:20px}p{color:#a9b4c0}</style></head>
<body><div class="c"><h1>${ok ? "İşlem tamamlandı" : "İşlem iptal edildi"}</h1>
<p>${ok ? "Aboneliğiniz güncellendi. Kenet uygulamasına dönebilirsiniz." : "Bir şey değişmedi. Uygulamaya dönebilirsiniz."}</p></div></body></html>`;

const httpServer = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (url.pathname === "/healthz" || url.pathname === "/") {
    json(res, 200, { status: "ok", service: "kenet-signal", billing: Boolean(env.stripe.secretKey) });
    return;
  }
  if (url.pathname === "/turn-credentials") {
    const header = req.headers.authorization;
    const bearer = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    turnCredentials(res, bearer ?? url.searchParams.get("token") ?? undefined);
    return;
  }
  if (url.pathname === "/billing/return") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(RETURN_PAGE(url.searchParams.get("ok") !== "0"));
    return;
  }
  if (url.pathname === "/billing/webhook" && req.method === "POST") {
    void readRawBody(req).then(async (raw) => {
      try {
        await handleWebhookEvent(raw, String(req.headers["stripe-signature"] ?? ""));
        json(res, 200, { received: true });
      } catch (error) {
        console.error("Webhook error:", error instanceof Error ? error.message : error);
        json(res, 400, { error: "Webhook verification failed." });
      }
    });
    return;
  }

  void api.handle(req, res, url).then((handled) => {
    if (!handled && !res.writableEnded) json(res, 404, { error: "Not found." });
  });
});

const wss = new WebSocketServer({ noServer: true });
httpServer.on("upgrade", (req, socket, head) => {
  if (new URL(req.url ?? "/", "http://x").pathname !== "/ws") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => handleConnection(ws));
});

const start = async (): Promise<void> => {
  await migrate();
  httpServer.listen(env.port, () => console.log(`Kenet backend listening on :${env.port}`));
};

start().catch((error) => {
  console.error("Failed to start:", error);
  process.exit(1);
});
