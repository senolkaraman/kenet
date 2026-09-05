import type { ClientMessage, ServerMessage, SignalPayload } from "@kenet/protocol";
import { wsUrl } from "./api";

type Handlers = {
  onReady: (sessionId: string, deviceId: string | undefined) => void;
  onSignal: (from: string, fromDevice: string | undefined, payload: SignalPayload) => void;
  onPeerOffline: (to: string) => void;
  onWake: (mac: string) => void;
  onError: (code: string, message: string) => void;
  onClose: () => void;
};

/** Signalling WebSocket client with token auth and exponential-backoff reconnect. */
export class SignalClient {
  private socket: WebSocket | undefined;
  private closedByUs = false;
  private retry = 0;
  private reconnectTimer: number | undefined;
  private token = "";
  private name = "";
  private netInfo: { mac: string; subnet: string } = { mac: "", subnet: "" };

  constructor(private readonly handlers: Handlers) {}

  /** LAN identity for Wake-on-LAN — sent with every hello so the server knows which devices
   *  share a network (relay candidates) and this device's MAC (so it can be woken later).
   *  If we already connected before this info arrived, re-announce it right away. */
  setNetworkInfo(info: { mac: string; subnet: string }): void {
    this.netInfo = info;
    if (this.socket?.readyState === WebSocket.OPEN && info.mac) {
      this.sendRaw({ type: "hello", token: this.token, name: this.name, mac: info.mac, subnet: info.subnet || undefined });
    }
  }

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
    this.socket.onopen = () =>
      this.sendRaw({
        type: "hello",
        token: this.token,
        name: this.name,
        mac: this.netInfo.mac || undefined,
        subnet: this.netInfo.subnet || undefined
      });
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
      } else if (message.type === "wake") {
        this.handlers.onWake(message.mac);
      } else if (message.type === "error") {
        this.handlers.onError(message.code, message.message);
      }
    };
    this.socket.onclose = (event) => {
      this.handlers.onClose();
      if (this.closedByUs) return;
      if (event.code === 1008) {
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
    this.reconnectTimer = window.setTimeout(() => this.connect(this.token, this.name), delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  close(): void {
    this.closedByUs = true;
    this.clearReconnect();
    this.socket?.close();
    this.socket = undefined;
  }
}
