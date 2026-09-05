import type { ClientMessage, ServerMessage, SignalPayload } from "./protocol";
import { wsUrl } from "./config";

type Handlers = {
  onReady: (sessionId: string, deviceId: string | undefined) => void;
  onSignal: (from: string, fromDevice: string | undefined, payload: SignalPayload) => void;
  onPeerOffline: (to: string) => void;
  onError: (code: string, message: string) => void;
  onClose: () => void;
};

/** Signalling WebSocket client with token auth and exponential-backoff reconnect.
 *  Ported from the desktop app; mobile connects with the account token (it has no
 *  device token of its own yet — it acts purely as a controller). */
export class SignalClient {
  private socket: WebSocket | undefined;
  private closedByUs = false;
  private retry = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private token = "";
  private name = "";

  constructor(private readonly handlers: Handlers) {}

  connect(token: string, name: string): void {
    this.token = token;
    this.name = name;
    this.closedByUs = false;
    this.clearReconnect();
    try {
      this.socket = new WebSocket(wsUrl());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket.onopen = () => this.sendRaw({ type: "hello", token: this.token, name: this.name });
    this.socket.onmessage = ({ data }) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(data)) as ServerMessage;
      } catch {
        return;
      }
      if (message.type === "ready") {
        this.retry = 0;
        this.handlers.onReady(message.sessionId, message.deviceId);
      } else if (message.type === "signal") {
        this.handlers.onSignal(message.from, message.fromDevice, message.payload);
      } else if (message.type === "peer-offline") {
        this.handlers.onPeerOffline(message.to);
      } else if (message.type === "error") {
        this.handlers.onError(message.code, message.message);
      }
    };
    this.socket.onclose = (event) => {
      this.handlers.onClose();
      if (this.closedByUs) return;
      if ((event as { code?: number }).code === 1008) {
        this.handlers.onError("UNAUTHORIZED", "Oturum doğrulanamadı. Yeniden giriş yapın.");
        return;
      }
      this.scheduleReconnect();
    };
    this.socket.onerror = () => this.socket?.close();
  }

  reconnectWith(token: string, name: string): void {
    this.close();
    this.connect(token, name);
  }

  signal(to: string, payload: SignalPayload): void {
    this.sendRaw({ type: "signal", to, payload });
  }

  private sendRaw(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private scheduleReconnect(): void {
    this.clearReconnect();
    const delay = Math.min(15000, 800 * 2 ** this.retry++);
    this.reconnectTimer = setTimeout(() => this.connect(this.token, this.name), delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  close(): void {
    this.closedByUs = true;
    this.clearReconnect();
    this.socket?.close();
    this.socket = undefined;
  }
}
