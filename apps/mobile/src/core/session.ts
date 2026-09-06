import { AppState } from "react-native";
import {
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate,
  type MediaStream
} from "react-native-webrtc";
import type { SignalPayload } from "./protocol";
import { Store } from "./store";
import { SignalClient } from "./signal";
import { decode, encode, type ControlCommand, type DataMessage } from "./messages";
import { authStore } from "./auth";
import { api } from "./api";

type RTCDataChannel = ReturnType<RTCPeerConnection["createDataChannel"]>;

export type Phase =
  | "offline"
  | "online"
  | "requesting"
  | "connecting"
  | "reconnecting"
  | "active"
  | "ended"
  | "error";

export interface SessionState {
  phase: Phase;
  registered: boolean;
  peerCode: string | null;
  peerName: string | null;
  message: string;
  controlOffered: boolean;
  controlActive: boolean;
  remoteStream: MediaStream | null;
  startedAt: number | null;
}

const initialState: SessionState = {
  phase: "offline",
  registered: false,
  peerCode: null,
  peerName: null,
  message: "",
  controlOffered: false,
  controlActive: false,
  remoteStream: null,
  startedAt: null
};

// Free public STUN, a few for redundancy. TURN is added from the server's /turn-credentials
// when configured (needed only when both peers are behind symmetric NAT).
const STUN_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" }
];

export class SessionController {
  readonly store = new Store<SessionState>(initialState);

  private signal: SignalClient;
  private pc: RTCPeerConnection | undefined;
  private channel: RTCDataChannel | undefined;
  private iceServers: RTCIceServer[] = [...STUN_SERVERS];
  private started = false;
  private lastToken: string | null = null;
  private reconnectAttempts = 0;
  private deviceName = "Kenet Mobil";

  private get = () => this.store.get();
  private set = (patch: Partial<SessionState> | ((p: SessionState) => Partial<SessionState>)) => this.store.set(patch);

  constructor() {
    this.signal = new SignalClient({
      onReady: () => {
        this.set({ registered: true, message: "", phase: this.get().phase === "offline" ? "online" : this.get().phase });
      },
      onSignal: (from, _fromDevice, payload) => void this.handleSignal(from, payload),
      onPeerOffline: () => {
        if (this.get().phase === "requesting") {
          this.set({ phase: "online", peerCode: null, message: "Hedef cihaz çevrimdışı." });
        }
      },
      onError: (code, message) => {
        this.set({ message });
        if (code === "UNAUTHORIZED") this.set({ registered: false });
      },
      onClose: () => this.set({ registered: false, phase: this.get().phase === "online" ? "offline" : this.get().phase })
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    authStore.subscribe(() => this.syncConnection());
    this.syncConnection();
    void this.loadIceServers();
    // A remote session in the background is dead weight (video decode stops) and the peer
    // gets stuck reconnecting to us. End it cleanly the moment the app leaves the foreground.
    AppState.addEventListener("change", (next) => {
      if (next !== "active" && this.inLiveSession()) this.endSession("Uygulama arka plana alındı.");
    });
  }

  private inLiveSession(): boolean {
    const p = this.get().phase;
    return p === "active" || p === "connecting" || p === "requesting" || p === "reconnecting";
  }

  private syncConnection(): void {
    const token = authStore.get().token;
    if (!token) {
      if (this.lastToken) {
        this.lastToken = null;
        this.signal.close();
        this.set({ registered: false, phase: "offline" });
      }
      return;
    }
    if (token !== this.lastToken) {
      this.lastToken = token;
      this.signal.reconnectWith(token, this.deviceName);
      void this.loadIceServers();
    }
  }

  private async loadIceServers(): Promise<void> {
    const token = authStore.get().token;
    if (!token) return;
    try {
      const config = await api<{ iceServers?: RTCIceServer[] }>("/turn-credentials", { token });
      if (config.iceServers?.length) this.iceServers = [...STUN_SERVERS, ...config.iceServers];
    } catch {
      /* STUN-only fallback */
    }
  }

  // ---------- outgoing connection ----------

  connectTo(code: string, unattendedTicket?: string): void {
    const target = code.trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(target)) {
      this.set({ message: "Altı karakterli cihaz kodunu girin." });
      return;
    }
    if (!this.get().registered) {
      this.set({ message: "Sunucuya bağlanılıyor, birazdan tekrar deneyin." });
      return;
    }
    const requestId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    this.set({
      phase: "requesting",
      peerCode: target,
      peerName: target,
      message: unattendedTicket ? "Gözetimsiz bağlanılıyor…" : "Bağlantı onayı bekleniyor…"
    });
    this.signal.signal(target, {
      type: "connection-request",
      requestId,
      requesterName: this.deviceName,
      unattended: unattendedTicket
    });
  }

  // ---------- signalling ----------

  private async handleSignal(from: string, payload: SignalPayload): Promise<void> {
    if (payload.type === "connection-decision") {
      if (!payload.approved) {
        const msg =
          payload.reason === "busy"
            ? "Karşı cihaz şu an başka bir oturumda. Birazdan tekrar deneyin."
            : "Bağlantı isteği reddedildi.";
        this.set({ phase: "ended", peerCode: null, message: msg });
        setTimeout(() => {
          if (this.get().phase === "ended") this.set({ phase: this.get().registered ? "online" : "offline" });
        }, 2500);
        return;
      }
      this.set({
        phase: "connecting",
        peerCode: from,
        controlOffered: payload.controlAllowed,
        message: payload.controlAllowed ? "Bağlantı onaylandı (denetim izniyle)." : "Bağlantı onaylandı (görüntüleme)."
      });
      await this.createOffer(from);
      return;
    }

    const pc = this.ensurePeer(from);
    if (payload.type === "answer") {
      await pc.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp: payload.sdp }));
    } else if (payload.type === "offer") {
      // Host never offers first in this flow, but handle it for completeness.
      await pc.setRemoteDescription(new RTCSessionDescription({ type: "offer", sdp: payload.sdp }));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.signal.signal(from, { type: "answer", sdp: answer.sdp ?? "" });
    } else if (payload.type === "ice-candidate") {
      try {
        await pc.addIceCandidate(
          new RTCIceCandidate({
            candidate: payload.candidate,
            sdpMid: payload.sdpMid,
            sdpMLineIndex: payload.sdpMLineIndex
          })
        );
      } catch {
        /* ignore late candidates */
      }
    }
  }

  private ensurePeer(route: string): RTCPeerConnection {
    if (this.pc) return this.pc;
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.pc = pc;

    // react-native-webrtc surfaces these as EventTarget-style events.
    (pc as unknown as { addEventListener: Function }).addEventListener("icecandidate", (event: { candidate?: RTCIceCandidate }) => {
      if (event.candidate) {
        this.signal.signal(route, {
          type: "ice-candidate",
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid ?? null,
          sdpMLineIndex: event.candidate.sdpMLineIndex ?? null
        });
      }
    });
    (pc as unknown as { addEventListener: Function }).addEventListener("track", (event: { streams: MediaStream[] }) => {
      this.set({ remoteStream: event.streams[0] ?? null });
    });
    (pc as unknown as { addEventListener: Function }).addEventListener("datachannel", (event: { channel: RTCDataChannel }) => {
      this.bindChannel(event.channel);
    });
    (pc as unknown as { addEventListener: Function }).addEventListener("connectionstatechange", () => {
      const s = (pc as unknown as { connectionState: string }).connectionState;
      if (s === "connected") this.onConnected();
      else if (s === "disconnected" || s === "failed") this.onDropped();
    });
    return pc;
  }

  private async createOffer(route: string): Promise<void> {
    const pc = this.ensurePeer(route);
    this.bindChannel(pc.createDataChannel("kenet", { ordered: true }));
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" });
    const offer = await pc.createOffer({});
    await pc.setLocalDescription(offer);
    this.signal.signal(route, { type: "offer", sdp: offer.sdp ?? "" });
  }

  private onConnected(): void {
    this.reconnectAttempts = 0;
    this.set({ phase: "active", startedAt: Date.now(), message: "Güvenli oturum etkin." });
  }

  private onDropped(): void {
    if (this.get().phase !== "active" && this.get().phase !== "connecting") return;
    this.reconnectAttempts += 1;
    if (this.reconnectAttempts > 3) {
      this.endSession("Bağlantı koptu.");
      return;
    }
    this.set({ phase: "reconnecting", message: "Bağlantı yeniden kuruluyor…" });
    (this.pc as unknown as { restartIce?: () => void })?.restartIce?.();
  }

  // ---------- data channel ----------

  private bindChannel(channel: RTCDataChannel): void {
    this.channel = channel;
    const ch = channel as unknown as {
      onmessage: (event: { data: unknown }) => void;
      onclose: () => void;
    };
    ch.onmessage = (event) => {
      if (typeof event.data === "string") this.onData(decode(event.data));
    };
    ch.onclose = () => {
      this.channel = undefined;
    };
  }

  private send(message: DataMessage): void {
    if ((this.channel as unknown as { readyState?: string })?.readyState === "open") {
      this.channel!.send(encode(message));
    }
  }

  private onData(message: DataMessage | null): void {
    if (!message) return;
    if (message.type === "bye") this.endSession("Karşı taraf oturumu sonlandırdı.");
  }

  // ---------- control (viewer -> host) ----------

  setControlActive(active: boolean): void {
    if (!this.get().controlOffered) return;
    this.set({ controlActive: active });
  }

  sendControl(command: ControlCommand): void {
    if (this.get().controlActive) this.send({ type: "control", command });
  }

  requestQuality(mode: "auto" | "sharp" | "smooth"): void {
    this.send({ type: "quality", mode });
  }

  // ---------- teardown ----------

  endSession(reason = "Oturum sonlandırıldı."): void {
    if (reason !== "Karşı taraf oturumu sonlandırdı.") this.send({ type: "bye" });
    try {
      this.channel?.close();
    } catch {
      /* noop */
    }
    this.channel = undefined;
    try {
      this.pc?.close();
    } catch {
      /* noop */
    }
    this.pc = undefined;
    this.reconnectAttempts = 0;
    this.set({
      phase: this.get().registered ? "online" : "offline",
      peerCode: null,
      peerName: null,
      remoteStream: null,
      controlOffered: false,
      controlActive: false,
      startedAt: null,
      message: reason
    });
  }
}

export const session = new SessionController();
