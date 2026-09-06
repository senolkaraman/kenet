import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type { ClientMessage, ServerMessage } from "@kenet/protocol";
import { verifyToken } from "./jwt.js";
import { query } from "./db.js";
import { addConn, getConn, removeConn, resolve, updateSubnet } from "./presence.js";
import { rateLimit } from "./ratelimit.js";

const HEARTBEAT_MS = 25_000;

const send = (socket: WebSocket, message: ServerMessage): void => {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
};

export const handleConnection = (socket: WebSocket): void => {
  let sessionId: string | undefined;
  let ownerId: string | undefined;
  let role: "device" | "controller" | undefined;
  let ownerIsAdmin = false;

  const authTimer = setTimeout(() => {
    if (!sessionId) {
      send(socket, { type: "error", code: "UNAUTHORIZED", message: "Authenticate within 10s." });
      socket.close(1008, "Unauthorized");
    }
  }, 10_000);

  // WebSocket "close" only fires on a clean disconnect. A dropped network, a sleeping
  // laptop, or a killed process often leaves the TCP socket half-open with no close
  // frame ever arriving — the connection then sits in `presence` forever, looking
  // "online" to everyone else while actually being dead. Ping/pong catches that: two
  // missed pongs in a row and we terminate the socket ourselves, which fires "close"
  // and cleans up presence.
  let alive = true;
  socket.on("pong", () => {
    alive = true;
  });
  const heartbeat = setInterval(() => {
    if (!alive) {
      socket.terminate();
      return;
    }
    alive = false;
    socket.ping();
  }, HEARTBEAT_MS);

  socket.on("message", async (raw) => {
    let message: ClientMessage;
    try {
      message = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      send(socket, { type: "error", code: "INVALID_MESSAGE", message: "Message must be valid JSON." });
      return;
    }

    if (message.type === "hello") {
      const claims = verifyToken(message.token);
      if (!claims) {
        send(socket, { type: "error", code: "UNAUTHORIZED", message: "Invalid token." });
        socket.close(1008, "Unauthorized");
        return;
      }

      const macFromMsg =
        typeof message.mac === "string" && /^[0-9a-f:]{12,17}$/i.test(message.mac) ? message.mac.toLowerCase() : null;
      const subnetFromMsg =
        typeof message.subnet === "string" && /^[0-9.]{7,15}\/\d{1,2}$/.test(message.subnet) ? message.subnet : undefined;

      // A second hello on an already-authed socket is just a late net-info update (the client
      // learns its MAC/subnet asynchronously) — refresh it in place, don't re-register.
      if (sessionId && role === "device" && claims.typ === "device" && claims.sub === getConn(sessionId)?.deviceId) {
        updateSubnet(sessionId, subnetFromMsg);
        if (macFromMsg || subnetFromMsg) {
          void query("update devices set mac_address = coalesce($2, mac_address), last_subnet = coalesce($3, last_subnet) where id = $1", [
            claims.sub,
            macFromMsg,
            subnetFromMsg ?? null
          ]);
        }
        return;
      }

      const acctId = claims.typ === "device" ? claims.uid : claims.sub;
      const acct = (
        await query<{ disabled: boolean; is_admin: boolean }>(
          "select disabled, is_admin from users where id = $1",
          [acctId]
        )
      ).rows[0];
      if (acct?.disabled) {
        send(socket, { type: "error", code: "FORBIDDEN", message: "Bu hesap devre dışı bırakıldı." });
        socket.close(1008, "Account disabled");
        return;
      }
      ownerIsAdmin = acct?.is_admin ?? false;

      clearTimeout(authTimer);
      sessionId = randomUUID();
      if (claims.typ === "device") {
        role = "device";
        ownerId = claims.uid;
        addConn({ socket, sessionId, role, userId: claims.uid, deviceId: claims.sub, subnet: subnetFromMsg });
        void query(
          `update devices set last_seen_at = now(), name = coalesce($2, name),
                              mac_address = coalesce($3, mac_address), last_subnet = coalesce($4, last_subnet)
             where id = $1`,
          [
            claims.sub,
            typeof message.name === "string" && message.name.trim() ? message.name.trim().slice(0, 60) : null,
            macFromMsg,
            subnetFromMsg ?? null
          ]
        );
        send(socket, { type: "ready", role, sessionId, deviceId: claims.sub });
      } else {
        role = "controller";
        ownerId = claims.sub;
        addConn({ socket, sessionId, role, userId: claims.sub });
        send(socket, { type: "ready", role, sessionId });
      }
      return;
    }

    if (!sessionId || !ownerId || !role) {
      send(socket, { type: "error", code: "UNAUTHORIZED", message: "Send hello first." });
      return;
    }

    if (message.type === "signal") {
      // Reachability is by device code, like a phone number — no account-matching gate.
      // The real access control is the target's own approval dialog, or a correct
      // unattended password. Rate-limited per sender so a script can't mass-scan codes
      // to spam approval popups on other people's devices.
      if (message.payload.type === "connection-request" && !rateLimit(`connreq:${ownerId}`, 20, 60_000, ownerIsAdmin)) {
        send(socket, {
          type: "error",
          code: "INVALID_MESSAGE",
          message: "Çok fazla bağlantı isteği. Birazdan tekrar deneyin."
        });
        return;
      }

      const target = resolve(message.to);
      if (!target || target.socket.readyState !== target.socket.OPEN) {
        send(socket, { type: "peer-offline", to: message.to });
        return;
      }
      const self = getConn(sessionId);

      let payload = message.payload;
      if (payload.type === "connection-request" && payload.unattended) {
        const ticket = verifyToken(payload.unattended);
        const verified = ticket?.typ === "unattended" && ticket.sub === target.deviceId;
        payload = { ...payload, unattended: verified ? "verified" : undefined };
      }

      send(target.socket, {
        type: "signal",
        from: sessionId,
        fromDevice: self?.deviceId,
        payload
      });
      return;
    }

    send(socket, { type: "error", code: "INVALID_MESSAGE", message: "Unknown message type." });
  });

  socket.on("close", () => {
    clearTimeout(authTimer);
    clearInterval(heartbeat);
    if (sessionId) removeConn(sessionId);
  });
};
