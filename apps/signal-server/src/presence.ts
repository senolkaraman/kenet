import type { WebSocket } from "ws";

/** In-memory connection registry. Single Cloud Run instance for now (min=max=1). */
interface Conn {
  socket: WebSocket;
  sessionId: string;
  role: "device" | "controller";
  userId: string;
  deviceId?: string;
  /** LAN this device reported on its last hello (e.g. "192.168.1.0/24") — used to pick a
   *  Wake-on-LAN relay that's actually on the same network as the device being woken. */
  subnet?: string;
}

const bySession = new Map<string, Conn>();
const deviceToSession = new Map<string, string>();

export const addConn = (conn: Conn): void => {
  bySession.set(conn.sessionId, conn);
  if (conn.deviceId) deviceToSession.set(conn.deviceId, conn.sessionId);
};

export const removeConn = (sessionId: string): void => {
  const conn = bySession.get(sessionId);
  if (!conn) return;
  bySession.delete(sessionId);
  if (conn.deviceId && deviceToSession.get(conn.deviceId) === sessionId) {
    deviceToSession.delete(conn.deviceId);
  }
};

export const isDeviceOnline = (deviceId: string): boolean => deviceToSession.has(deviceId);

/** Late net-info update: the client learns its own MAC/subnet a moment after connecting. */
export const updateSubnet = (sessionId: string, subnet: string | undefined): void => {
  const conn = bySession.get(sessionId);
  if (conn && subnet) conn.subnet = subnet;
};

/** Resolve a routing target given either a live sessionId or an online deviceId. */
export const resolve = (target: string): Conn | undefined => {
  const direct = bySession.get(target);
  if (direct) return direct;
  const sessionId = deviceToSession.get(target);
  return sessionId ? bySession.get(sessionId) : undefined;
};

export const getConn = (sessionId: string): Conn | undefined => bySession.get(sessionId);

/**
 * Sends a Wake-on-LAN magic-packet request to an online device that can relay it for
 * `targetDeviceId`: same owner, same reported LAN, and not the target itself (it's offline anyway).
 * Returns the relaying device's id, or null if there's no suitable device online.
 */
export const sendWakeRequest = (
  ownerId: string,
  subnet: string,
  targetDeviceId: string,
  mac: string
): string | null => {
  for (const conn of bySession.values()) {
    if (
      conn.role === "device" &&
      conn.userId === ownerId &&
      conn.deviceId &&
      conn.deviceId !== targetDeviceId &&
      conn.subnet === subnet &&
      conn.socket.readyState === conn.socket.OPEN
    ) {
      conn.socket.send(JSON.stringify({ type: "wake", mac }));
      return conn.deviceId;
    }
  }
  return null;
};

/** Force-closes a device's live connection (e.g. after its code was rotated) so it must reconnect. */
export const terminateDevice = (deviceId: string): boolean => {
  const sessionId = deviceToSession.get(deviceId);
  const conn = sessionId ? bySession.get(sessionId) : undefined;
  conn?.socket.terminate();
  return Boolean(conn);
};
