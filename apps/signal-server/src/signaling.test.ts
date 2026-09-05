import { randomUUID } from "node:crypto";
import { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newDb, DataType } from "pg-mem";
import { WebSocket, WebSocketServer } from "ws";
import type { ClientMessage, ServerMessage } from "@kenet/protocol";

process.env.JWT_SECRET = "sig-test-secret";

const { setPool, migrate } = await import("./db.js");
const mem = newDb();
mem.public.registerFunction({ name: "gen_random_uuid", returns: DataType.uuid, impure: true, implementation: () => randomUUID() });
setPool(new (mem.adapters.createPg().Pool)());

const { registerHandler } = await import("./auth.js");
const { registerDeviceHandler, patchDeviceHandler, unattendedTicketHandler, wakeDeviceHandler } = await import(
  "./devices.js"
);
const { handleConnection } = await import("./signaling.js");
const { verifyToken, signUnattendedTicket } = await import("./jwt.js");
const { query } = await import("./db.js");
const grantPro = (userId: string) =>
  query("update users set plan = 'pro', subscription_status = 'active' where id = $1", [userId]);

let ipCounter = 0;
const ctx = (body: unknown, token?: string) => ({
  req: {} as never,
  res: {} as never,
  url: new URL("http://x/"),
  params: {} as Record<string, string>,
  body,
  claims: token ? verifyToken(token) : null,
  ip: `test-${ipCounter++}`
});

let server: Server;
let url: string;

beforeAll(async () => {
  await migrate();
  const wss = new WebSocketServer({ noServer: true });
  server = createServer();
  server.on("upgrade", (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => handleConnection(ws)));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  url = `ws://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

const open = (token: string) =>
  new Promise<{ ws: WebSocket; ready: ServerMessage & { type: "ready" } }>((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as ServerMessage;
      if (msg.type === "ready") resolve({ ws, ready: msg });
      else reject(new Error(JSON.stringify(msg)));
    });
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", token } satisfies ClientMessage)));
    ws.on("error", reject);
  });

const next = (ws: WebSocket) =>
  new Promise<ServerMessage>((resolve) => ws.once("message", (raw) => resolve(JSON.parse(raw.toString()) as ServerMessage)));

describe("signalling relay", () => {
  it("routes a connection request between two devices of the same account", async () => {
    const account = await registerHandler(ctx({ email: "relay@test.com", password: "supersecret" }));
    const devA = await registerDeviceHandler(ctx({ name: "A" }, account.token));
    const devB = await registerDeviceHandler(ctx({ name: "B" }, account.token));

    const a = await open(devA.deviceToken);
    const b = await open(devB.deviceToken);

    a.ws.send(
      JSON.stringify({
        type: "signal",
        to: devB.device.id,
        payload: { type: "connection-request", requestId: "r1", requesterName: "A" }
      } satisfies ClientMessage)
    );

    const received = (await next(b.ws)) as ServerMessage & { type: "signal" };
    expect(received.type).toBe("signal");
    expect(received.payload.type).toBe("connection-request");
    expect(received.fromDevice).toBe(devA.device.id);

    b.ws.send(
      JSON.stringify({
        type: "signal",
        to: received.from,
        payload: { type: "connection-decision", requestId: "r1", approved: true, controlAllowed: true }
      } satisfies ClientMessage)
    );

    const decision = (await next(a.ws)) as ServerMessage & { type: "signal" };
    expect(decision.payload).toMatchObject({ type: "connection-decision", approved: true });

    a.ws.close();
    b.ws.close();
  });

  it("marks a valid unattended ticket as verified and strips an invalid one", async () => {
    const account = await registerHandler(ctx({ email: "una@test.com", password: "supersecret" }));
    await grantPro(account.user.id);
    const devA = await registerDeviceHandler(ctx({ name: "A" }, account.token));
    const devB = await registerDeviceHandler(ctx({ name: "B" }, account.token));
    const patch = ctx({ unattendedPassword: "open-sesame" }, account.token);
    patch.params.id = devB.device.id;
    await patchDeviceHandler(patch);
    const tick = ctx({ password: "open-sesame" }, account.token);
    tick.params.id = devB.device.id;
    const { ticket } = await unattendedTicketHandler(tick);

    const a = await open(devA.deviceToken);
    const b = await open(devB.deviceToken);

    a.ws.send(
      JSON.stringify({
        type: "signal",
        to: devB.device.id,
        payload: { type: "connection-request", requestId: "u1", requesterName: "A", unattended: ticket }
      } satisfies ClientMessage)
    );
    const good = (await next(b.ws)) as ServerMessage & { type: "signal" };
    expect((good.payload as { unattended?: string }).unattended).toBe("verified");

    a.ws.send(
      JSON.stringify({
        type: "signal",
        to: devB.device.id,
        payload: {
          type: "connection-request",
          requestId: "u2",
          requesterName: "A",
          unattended: signUnattendedTicket("WRONGID", account.user.id)
        }
      } satisfies ClientMessage)
    );
    const bad = (await next(b.ws)) as ServerMessage & { type: "signal" };
    expect((bad.payload as { unattended?: string }).unattended).toBeUndefined();

    a.ws.close();
    b.ws.close();
  });

  it("routes a connection request between devices on two different accounts", async () => {
    // Reachability is by device code, not account membership — like calling a phone
    // number. This is the whole point of the tool: unrelated people connect to each other.
    const owner = await registerHandler(ctx({ email: "cross-a@test.com", password: "supersecret" }));
    const stranger = await registerHandler(ctx({ email: "cross-b@test.com", password: "supersecret" }));
    const host = await registerDeviceHandler(ctx({ name: "host" }, owner.token));
    const viewer = await registerDeviceHandler(ctx({ name: "viewer" }, stranger.token));

    const a = await open(viewer.deviceToken);
    const b = await open(host.deviceToken);

    a.ws.send(
      JSON.stringify({
        type: "signal",
        to: host.device.id,
        payload: { type: "connection-request", requestId: "x1", requesterName: "stranger" }
      } satisfies ClientMessage)
    );
    const received = (await next(b.ws)) as ServerMessage & { type: "signal" };
    expect(received.payload.type).toBe("connection-request");

    a.ws.close();
    b.ws.close();
  });

  it("verifies an unattended ticket even when the requester is a different account", async () => {
    const owner = await registerHandler(ctx({ email: "cross-owner@test.com", password: "supersecret" }));
    await grantPro(owner.user.id);
    const requester = await registerHandler(ctx({ email: "cross-req@test.com", password: "supersecret" }));
    const host = await registerDeviceHandler(ctx({ name: "host" }, owner.token));
    const patch = ctx({ unattendedPassword: "shared-secret" }, owner.token);
    patch.params.id = host.device.id;
    await patchDeviceHandler(patch);

    const tick = ctx({ password: "shared-secret" }, requester.token);
    tick.params.id = host.device.id;
    const { ticket } = await unattendedTicketHandler(tick);

    const requesterDevice = await registerDeviceHandler(ctx({ name: "req-pc" }, requester.token));
    const a = await open(requesterDevice.deviceToken);
    const b = await open(host.deviceToken);

    a.ws.send(
      JSON.stringify({
        type: "signal",
        to: host.device.id,
        payload: { type: "connection-request", requestId: "u3", requesterName: "req", unattended: ticket }
      } satisfies ClientMessage)
    );
    const received = (await next(b.ws)) as ServerMessage & { type: "signal" };
    expect((received.payload as { unattended?: string }).unattended).toBe("verified");

    a.ws.close();
    b.ws.close();
  });

  it("relays a Wake-on-LAN request to an online device on the same LAN", async () => {
    const account = await registerHandler(ctx({ email: "wol@test.com", password: "supersecret" }));
    const relay = await registerDeviceHandler(ctx({ name: "laptop" }, account.token));
    const target = await registerDeviceHandler(ctx({ name: "desktop" }, account.token));

    const openWithNet = (token: string, mac: string, subnet: string) =>
      new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(url);
        ws.once("message", () => resolve(ws)); // first message is "ready"
        ws.on("open", () => ws.send(JSON.stringify({ type: "hello", token, mac, subnet } satisfies ClientMessage)));
        ws.on("error", reject);
      });

    // Both report the same LAN; the target then goes offline.
    const relayWs = await openWithNet(relay.deviceToken, "aa:bb:cc:dd:ee:01", "192.168.1.0/24");
    const targetWs = await openWithNet(target.deviceToken, "aa:bb:cc:dd:ee:02", "192.168.1.0/24");
    await new Promise((r) => setTimeout(r, 50));
    targetWs.close();
    await new Promise((r) => setTimeout(r, 100)); // let the server drop it from presence

    const c = ctx({}, account.token);
    c.params.id = target.device.id;
    const result = await wakeDeviceHandler(c);
    expect(result.via).toBe(relay.device.id);

    const woke = (await next(relayWs)) as ServerMessage & { type: "wake" };
    expect(woke.type).toBe("wake");
    expect(woke.mac).toBe("aa:bb:cc:dd:ee:02");

    relayWs.close();
  });

  it("refuses to wake a device with no known network, or with no relay online", async () => {
    const account = await registerHandler(ctx({ email: "wol2@test.com", password: "supersecret" }));
    const lonely = await registerDeviceHandler(ctx({ name: "never-connected" }, account.token));
    const c = ctx({}, account.token);
    c.params.id = lonely.device.id;
    await expect(wakeDeviceHandler(c)).rejects.toThrow(/ağ bilgisi/);
  });

  it("reports an offline peer", async () => {
    const account = await registerHandler(ctx({ email: "off@test.com", password: "supersecret" }));
    const devA = await registerDeviceHandler(ctx({ name: "A" }, account.token));
    const a = await open(devA.deviceToken);
    a.ws.send(JSON.stringify({ type: "signal", to: "ZZZZZZ", payload: { type: "offer", sdp: "x" } } satisfies ClientMessage));
    const msg = await next(a.ws);
    expect(msg.type).toBe("peer-offline");
    a.ws.close();
  });

  it("rejects an unauthenticated hello", async () => {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve) => ws.on("open", resolve));
    ws.send(JSON.stringify({ type: "hello", token: "garbage" } satisfies ClientMessage));
    const msg = await next(ws);
    expect(msg).toMatchObject({ type: "error", code: "UNAUTHORIZED" });
  });
});
