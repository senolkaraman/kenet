import type { SignalPayload } from "@kenet/protocol";
import { Store } from "./store";
import { SignalClient } from "./signal";
import { StatsProbe, emptyStats, linkGrade, type LinkStats } from "./stats";
import { decode, encode, type ControlCommand, type DataMessage, type FsEntry } from "./messages";
import { settingsStore } from "./settings";
import { authStore } from "./auth";
import { api } from "./api";
import { refreshDevices } from "./devices";

export type Phase =
  | "offline"
  | "online"
  | "requesting"
  | "incoming"
  | "connecting"
  | "reconnecting"
  | "active"
  | "ended"
  | "error";

export type Role = "idle" | "viewer" | "host";

export interface ChatEntry {
  id: string;
  mine: boolean;
  text: string;
  at: number;
}

export interface Transfer {
  id: string;
  name: string;
  size: number;
  direction: "in" | "out";
  state: "offered" | "active" | "done" | "rejected";
  received: number;
}

export interface SessionState {
  phase: Phase;
  role: Role;
  registered: boolean;
  peerRoute: string | null;
  peerName: string | null;
  message: string;
  quality: "ok" | "warn" | "bad";
  stats: LinkStats;
  chat: ChatEntry[];
  transfers: Transfer[];
  incoming: { from: string; name: string; requestId: string; fromDevice?: string } | null;
  remoteStream: MediaStream | null;
  controlOffered: boolean;
  controlActive: boolean;
  privacyActive: boolean;
  recordingActive: boolean;
  unattendedSession: boolean;
  startedAt: number | null;
  remoteClipboard: string | null;
}

const CHUNK = 64 * 1024;

// Free public STUN, a few for redundancy — if one is rate-limited or down, ICE still gathers
// reflexive candidates from another. STUN alone covers most home NATs; TURN (added by the server
// via /turn-credentials when configured) is only needed when both peers are behind symmetric NAT.
const STUN_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" }
];

const initialState: SessionState = {
  phase: "offline",
  role: "idle",
  registered: false,
  peerRoute: null,
  peerName: null,
  message: "",
  quality: "warn",
  stats: emptyStats,
  chat: [],
  transfers: [],
  incoming: null,
  remoteStream: null,
  controlOffered: false,
  controlActive: false,
  privacyActive: false,
  recordingActive: false,
  unattendedSession: false,
  startedAt: null,
  remoteClipboard: null
};

const auditLabels = new Set([
  "connection-requested",
  "connection-approved",
  "connection-rejected",
  "session-started",
  "session-ended",
  "file-sent",
  "file-received",
  "elevation-requested"
]);
const audit = (event: string, details: string) => {
  if (auditLabels.has(event)) window.kenetControl.recordAudit(event, details);
};

export class SessionController {
  readonly store = new Store<SessionState>(initialState);

  private signal: SignalClient;
  private pc: RTCPeerConnection | undefined;
  private channel: RTCDataChannel | undefined;
  private probe: StatsProbe | undefined;
  private localStream: MediaStream | undefined;
  private iceServers: RTCIceServer[] = [...STUN_SERVERS];
  private incoming:
    | {
        id: string;
        name: string;
        mime: string;
        size: number;
        chunks: ArrayBuffer[];
        clipboardBatch?: string;
        remoteWritePath?: string;
        autoSaveDownload?: boolean;
      }
    | undefined;
  private outgoingFile:
    | { id: string; file: File; clipboardBatch?: string; remoteWritePath?: string; autoSaveDownload?: boolean }
    | undefined;
  private outgoingResolvers = new Map<string, () => void>();
  private clipboardIncoming = new Map<string, { total: number; staged: string[] }>();
  private fsListResolvers = new Map<string, (r: { entries: FsEntry[]; error?: string }) => void>();
  private pendingDecision: { requestId: string; from: string } | undefined;
  private reconnectAttempts = 0;
  private reconnectDeadline: number | undefined;
  private started = false;
  private lastDeviceToken: string | null = null;
  private lastServerUrl = "";
  private peerDeviceId: string | undefined;
  private gradeHistory: Array<"ok" | "warn" | "bad"> = [];
  private autoQuality: "auto" | "smooth" = "auto";
  private recorder: MediaRecorder | undefined;
  private clipboardPoll: number | undefined;
  private lastClipboardText = "";
  private idleTimer: number | undefined;
  private lastActivityAt = 0;

  /** Viewer-side: nudge the host's encoder down on sustained poor links, back up when it recovers. */
  private adaptQuality(grade: "ok" | "warn" | "bad"): void {
    if (this.get().role !== "viewer" || settingsStore.get().quality !== "auto") return;
    this.gradeHistory.push(grade);
    if (this.gradeHistory.length > 6) this.gradeHistory.shift();
    if (this.gradeHistory.length < 4) return;

    const bad = this.gradeHistory.filter((g) => g === "bad").length;
    const ok = this.gradeHistory.filter((g) => g === "ok").length;
    if (bad >= 3 && this.autoQuality !== "smooth") {
      this.autoQuality = "smooth";
      this.requestQuality("smooth");
      this.set({ message: "Bağlantı zayıf — akıcı moda geçiliyor." });
    } else if (ok >= 5 && this.autoQuality !== "auto") {
      this.autoQuality = "auto";
      this.requestQuality("auto");
    }
  }

  private logActivity(kind: string): void {
    const token = authStore.get().deviceToken;
    if (!token) return;
    void api("/activity", { method: "POST", token, body: { kind, targetDeviceId: this.peerDeviceId } }).catch(() => {});
  }

  constructor() {
    this.signal = new SignalClient({
      onReady: () => {
        this.set({ registered: true, message: "", phase: this.get().role === "idle" ? "online" : this.get().phase });
      },
      onSignal: (from, fromDevice, payload) => void this.handleSignal(from, payload, fromDevice),
      onPeerOffline: () => {
        if (this.get().phase === "requesting") {
          this.set({ phase: this.get().registered ? "online" : "offline", role: "idle", message: "Hedef cihaz çevrimdışı." });
        }
      },
      onWake: (mac) => {
        void window.kenetControl.sendWakePacket?.(mac);
      },
      onError: (code, message) => {
        this.set({ message });
        if (code === "UNAUTHORIZED") this.set({ registered: false });
      },
      onClose: () => this.set({ registered: false, phase: this.get().role === "idle" ? "offline" : this.get().phase })
    });
  }

  private get = () => this.store.get();
  private set = (patch: Partial<SessionState> | ((p: SessionState) => Partial<SessionState>)) => this.store.set(patch);

  // ---------- lifecycle ----------

  start(): void {
    if (this.started) return;
    this.started = true;
    void window.kenetControl.getNetworkInfo?.().then((info) => {
      if (info) this.signal.setNetworkInfo(info);
    });
    authStore.subscribe(() => this.syncConnection());
    settingsStore.subscribe(() => this.syncConnection());
    this.syncConnection();
    void this.loadIceServers();
  }

  private syncConnection(): void {
    const token = authStore.get().deviceToken;
    const url = settingsStore.get().serverUrl;
    if (!token) {
      if (this.lastDeviceToken) {
        this.lastDeviceToken = null;
        this.signal.close();
        this.set({ registered: false, phase: "offline" });
      }
      return;
    }
    if (token !== this.lastDeviceToken || url !== this.lastServerUrl) {
      this.lastDeviceToken = token;
      this.lastServerUrl = url;
      this.signal.reconnectWith(token, settingsStore.get().deviceName);
      void this.loadIceServers();
    }
  }

  private async loadIceServers(): Promise<void> {
    const token = authStore.get().deviceToken ?? authStore.get().token;
    if (!token) return;
    try {
      const config = await api<{ iceServers?: RTCIceServer[] }>("/turn-credentials", { token });
      if (config.iceServers?.length) {
        this.iceServers = [...STUN_SERVERS, ...config.iceServers];
      }
    } catch {
      /* STUN-only fallback */
    }
  }

  // ---------- outgoing (viewer) ----------

  connectTo(deviceId: string, deviceName?: string, unattendedTicket?: string): void {
    const target = deviceId.trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(target)) {
      this.set({ message: "Altı karakterli cihaz kodunu girin." });
      return;
    }
    if (target === authStore.get().device?.id) {
      this.set({ message: "Bu cihaz zaten bu bilgisayar." });
      return;
    }
    if (!this.get().registered) {
      this.set({ message: "Sunucuya bağlanılıyor, birazdan tekrar deneyin." });
      return;
    }
    const requestId = crypto.randomUUID();
    this.pendingDecision = undefined;
    this.peerDeviceId = target;
    this.set({
      role: "viewer",
      phase: "requesting",
      peerRoute: target,
      peerName: deviceName ?? target,
      message: unattendedTicket ? "Gözetimsiz bağlanılıyor…" : "Bağlantı onayı bekleniyor…"
    });
    this.signal.signal(target, {
      type: "connection-request",
      requestId,
      requesterName: settingsStore.get().deviceName,
      unattended: unattendedTicket
    });
    audit("connection-requested", `${target}${unattendedTicket ? " (gözetimsiz)" : ""}`);
  }

  // ---------- incoming (host) ----------

  async approveIncoming(
    allowControl: boolean,
    explicit?: { from: string; name: string; requestId: string }
  ): Promise<void> {
    const req = explicit ?? this.get().incoming;
    if (!req) return;
    try {
      this.localStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
    } catch {
      this.set({ message: "Ekran paylaşımı reddedildi." });
      return;
    }
    this.set({
      role: "host",
      phase: "connecting",
      peerRoute: req.from,
      peerName: req.name,
      incoming: null,
      controlOffered: allowControl,
      message: "Bağlantı kuruluyor…"
    });
    this.signal.signal(req.from, {
      type: "connection-decision",
      requestId: req.requestId,
      approved: true,
      controlAllowed: allowControl
    });
    audit("connection-approved", `${req.name}${allowControl ? " (denetim izniyle)" : ""}`);
  }

  rejectIncoming(): void {
    const req = this.get().incoming;
    if (!req) return;
    this.signal.signal(req.from, {
      type: "connection-decision",
      requestId: req.requestId,
      approved: false,
      controlAllowed: false
    });
    this.set({ incoming: null, message: "Bağlantı isteği reddedildi." });
    audit("connection-rejected", req.name);
  }

  // ---------- signalling ----------

  private async handleSignal(from: string, payload: SignalPayload, fromDevice?: string): Promise<void> {
    if (payload.type === "connection-request") {
      if (fromDevice) this.peerDeviceId = fromDevice;
      if (this.get().role !== "idle") {
        this.signal.signal(from, {
          type: "connection-decision",
          requestId: payload.requestId,
          approved: false,
          controlAllowed: false,
          reason: "busy"
        });
        return;
      }
      const autoReq = { from, name: payload.requesterName, requestId: payload.requestId };
      if (payload.unattended === "verified") {
        // Server already checked the unattended password. Auto-accept with full control —
        // pass the request explicitly so the approval modal never even flashes.
        this.set({ unattendedSession: true, message: `${payload.requesterName} gözetimsiz erişimle bağlanıyor.` });
        await this.approveIncoming(true, autoReq);
        return;
      }
      // A device the host previously marked "always allow" — skip the approval dialog.
      if (fromDevice && settingsStore.get().trustedDevices.includes(fromDevice)) {
        this.set({ message: `${payload.requesterName} (güvenilir cihaz) bağlanıyor.` });
        await this.approveIncoming(true, autoReq);
        return;
      }
      this.set({
        phase: "incoming",
        incoming: { from, name: payload.requesterName, requestId: payload.requestId, fromDevice }
      });
      return;
    }

    if (payload.type === "connection-decision") {
      if (!payload.approved) {
        this.set({ phase: "ended", role: "idle", peerRoute: null, message: "Bağlantı isteği reddedildi." });
        window.setTimeout(() => {
          if (this.get().phase === "ended") this.set({ phase: this.get().registered ? "online" : "offline" });
        }, 2500);
        return;
      }
      this.set({
        phase: "connecting",
        peerRoute: from,
        controlOffered: payload.controlAllowed,
        controlActive: payload.controlAllowed && settingsStore.get().askBeforeControl === false,
        message: payload.controlAllowed
          ? "Denetim izni verildi. Almak için araç çubuğundaki imleç simgesine basın."
          : "Bağlantı onaylandı (yalnızca görüntüleme)."
      });
      await this.createOffer(from);
      return;
    }

    const pc = this.ensurePeer(from);
    if (payload.type === "offer") {
      await pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.signal.signal(from, { type: "answer", sdp: answer.sdp ?? "" });
    } else if (payload.type === "answer") {
      await pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
    } else {
      try {
        await pc.addIceCandidate({
          candidate: payload.candidate,
          sdpMid: payload.sdpMid,
          sdpMLineIndex: payload.sdpMLineIndex
        });
      } catch {
        /* ignore late candidates */
      }
    }
  }

  private ensurePeer(route: string): RTCPeerConnection {
    if (this.pc) return this.pc;
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.pc = pc;

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        this.signal.signal(route, {
          type: "ice-candidate",
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid,
          sdpMLineIndex: candidate.sdpMLineIndex
        });
      }
    };
    pc.ontrack = ({ streams }) => this.set({ remoteStream: streams[0] ?? null });
    pc.ondatachannel = ({ channel }) => this.bindChannel(channel);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") this.onConnected();
      else if (pc.connectionState === "disconnected" || pc.connectionState === "failed") this.onDropped();
    };

    if (this.localStream) {
      for (const track of this.localStream.getTracks()) pc.addTrack(track, this.localStream);
    }

    this.probe = new StatsProbe(pc, (stats) => {
      const grade = linkGrade(stats);
      this.set({ stats, quality: grade });
      this.adaptQuality(grade);
    });
    return pc;
  }

  private async createOffer(route: string): Promise<void> {
    const pc = this.ensurePeer(route);
    this.bindChannel(pc.createDataChannel("kenet", { ordered: true }));
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.signal.signal(route, { type: "offer", sdp: offer.sdp ?? "" });
  }

  private onConnected(): void {
    this.reconnectAttempts = 0;
    if (this.reconnectDeadline !== undefined) {
      window.clearTimeout(this.reconnectDeadline);
      this.reconnectDeadline = undefined;
    }
    this.probe?.start();
    this.set({ phase: "active", startedAt: Date.now(), message: "Güvenli oturum etkin." });
    audit("session-started", this.get().peerName ?? "cihaz");
    this.logActivity(this.get().unattendedSession ? "unattended-session" : "session-start");
    if (this.get().role === "host") void window.kenetControl.showOverlay?.();
    this.startClipboardSync();
    this.startIdleWatch();
    void refreshDevices();
  }

  // ---------- automatic clipboard sync ----------

  private startClipboardSync(): void {
    if (!settingsStore.get().clipboardSync || this.clipboardPoll) return;
    this.lastClipboardText = "";
    this.clipboardPoll = window.setInterval(() => {
      if (this.channel?.readyState !== "open") return;
      void window.kenetControl.readClipboard?.().then((text) => {
        if (typeof text !== "string" || !text || text === this.lastClipboardText) return;
        if (text.length > 256 * 1024) return; // don't sync huge pastes
        this.lastClipboardText = text;
        this.send({ type: "clipboard", text });
      });
    }, 1200);
  }

  private stopClipboardSync(): void {
    if (this.clipboardPoll) window.clearInterval(this.clipboardPoll);
    this.clipboardPoll = undefined;
  }

  // ---------- unattended idle timeout ----------

  private startIdleWatch(): void {
    if (this.idleTimer) return;
    this.lastActivityAt = Date.now();
    this.idleTimer = window.setInterval(() => {
      const mins = settingsStore.get().unattendedIdleTimeoutMin;
      if (!this.get().unattendedSession || mins <= 0) return;
      if (Date.now() - this.lastActivityAt > mins * 60_000) {
        this.endSession(`Boşta kalma (${mins} dk) nedeniyle oturum kapatıldı.`);
      }
    }, 30_000);
  }

  private stopIdleWatch(): void {
    if (this.idleTimer) window.clearInterval(this.idleTimer);
    this.idleTimer = undefined;
  }

  private onDropped(): void {
    const phase = this.get().phase;
    if (phase !== "active" && phase !== "connecting" && phase !== "reconnecting") return;
    this.reconnectAttempts += 1;
    if (this.reconnectAttempts > 3) {
      this.endSession("Bağlantı koptu.");
      return;
    }
    // Hard deadline: if we're not back to "active" within 25s of the first drop, give up.
    // Otherwise a peer that just vanished (phone backgrounded, laptop slept) leaves the UI
    // spinning on "Yeniden bağlanılıyor" forever.
    if (this.reconnectDeadline === undefined) {
      this.reconnectDeadline = window.setTimeout(() => {
        if (this.get().phase === "reconnecting") this.endSession("Bağlantı koptu.");
      }, 25_000);
    }
    this.set({ phase: "reconnecting", message: "Bağlantı yeniden kuruluyor…" });
    this.pc?.restartIce?.();
  }

  // ---------- data channel ----------

  private bindChannel(channel: RTCDataChannel): void {
    this.channel = channel;
    channel.binaryType = "arraybuffer";
    channel.onmessage = ({ data }) => {
      if (typeof data === "string") this.onData(decode(data));
      else if (this.incoming) {
        this.incoming.chunks.push(data as ArrayBuffer);
        const received = this.incoming.chunks.reduce((n, c) => n + c.byteLength, 0);
        this.updateTransfer(this.incoming.id, { received, state: "active" });
      }
    };
    channel.onclose = () => {
      this.channel = undefined;
    };
  }

  private send(message: DataMessage): void {
    if (this.channel?.readyState === "open") this.channel.send(encode(message));
  }

  private onData(message: DataMessage | null): void {
    if (!message) return;
    switch (message.type) {
      case "bye":
        this.endSession("Karşı taraf oturumu sonlandırdı.");
        break;
      case "chat":
        this.set((s) => ({
          chat: [...s.chat, { id: crypto.randomUUID(), mine: false, text: message.text, at: message.at }]
        }));
        break;
      case "control":
        if (this.get().role === "host" && this.get().controlOffered) {
          this.lastActivityAt = Date.now();
          window.kenetControl.send(message.command);
        }
        break;
      case "clipboard":
        // Mark it as "already seen" so the sync poll doesn't immediately echo it back.
        this.lastClipboardText = message.text;
        this.set({ remoteClipboard: message.text });
        void window.kenetControl.writeClipboard?.(message.text);
        break;
      case "file-offer": {
        this.incoming = {
          id: message.id,
          name: message.name,
          mime: message.mime,
          size: message.size,
          chunks: [],
          clipboardBatch: message.clipboardBatch,
          remoteWritePath: message.remoteWritePath,
          autoSaveDownload: message.autoSaveDownload
        };
        // Clipboard-paste transfers are fully silent (no Dosyalar entry either). File-manager
        // uploads/downloads still show up in the list for visibility, just pre-accepted —
        // the human already made the decision by clicking upload/download.
        const autoAccept = Boolean(message.clipboardBatch || message.remoteWritePath || message.autoSaveDownload);
        if (!message.clipboardBatch) {
          this.set((s) => ({
            transfers: [
              ...s.transfers,
              {
                id: message.id,
                name: message.name,
                size: message.size,
                direction: "in",
                state: autoAccept ? "active" : "offered",
                received: 0
              }
            ]
          }));
        }
        if (autoAccept) this.send({ type: "file-decision", id: message.id, accepted: true });
        break;
      }
      case "file-decision":
        if (message.accepted) void this.streamOutgoingFile(message.id);
        else {
          this.updateTransfer(message.id, { state: "rejected" });
          this.resolveOutgoing(message.id);
        }
        break;
      case "file-end":
        this.finishIncomingFile();
        break;
      case "quality":
        void this.applyQuality(message.mode);
        break;
      case "screen-pick":
        void this.switchScreen(message.id);
        break;
      case "clipboard-files-begin":
        this.clipboardIncoming.set(message.batch, { total: message.count, staged: [] });
        break;
      case "clipboard-files-ready":
        this.set({ message: `${message.count} dosya karşı tarafın panosuna kondu.` });
        break;
      case "fs-list":
        // Only the host side ever answers this, and only when it explicitly offered control —
        // browsing/reading the disk is at least as sensitive as remote input, so it rides the
        // same trust decision instead of a separate prompt per request.
        if (this.get().role === "host" && this.get().controlOffered) {
          void (async () => {
            const result = message.path
              ? await window.kenetControl.listDir?.(message.path)
              : await window.kenetControl.listDrives?.();
            this.send({
              type: "fs-list-result",
              reqId: message.reqId,
              path: message.path,
              entries: result?.entries ?? [],
              error: result?.ok === false ? result.error : undefined
            });
          })();
        } else {
          this.send({ type: "fs-list-result", reqId: message.reqId, path: message.path, entries: [], error: "İzin yok." });
        }
        break;
      case "fs-list-result": {
        const resolver = this.fsListResolvers.get(message.reqId);
        if (resolver) {
          resolver({ entries: message.entries, error: message.error });
          this.fsListResolvers.delete(message.reqId);
        }
        break;
      }
      case "fs-download":
        if (this.get().role === "host" && this.get().controlOffered) {
          void (async () => {
            const result = await window.kenetControl.readFileForTransfer?.(message.path);
            if (!result?.ok || !result.data || !result.name) {
              this.send({ type: "fs-download-error", reqId: message.reqId, error: result?.error ?? "Dosya okunamadı." });
              return;
            }
            const file = new File([result.data], result.name);
            this.offerFile(file, { autoSaveDownload: true });
          })();
        } else {
          this.send({ type: "fs-download-error", reqId: message.reqId, error: "İzin yok." });
        }
        break;
      case "fs-download-error":
        this.set({ message: `İndirilemedi: ${message.error}` });
        break;
      case "annotate":
        if (this.get().role === "host") window.kenetControl.overlayDraw?.(message);
        break;
      default:
        break;
    }
  }

  private resolveOutgoing(id: string): void {
    this.outgoingResolvers.get(id)?.();
    this.outgoingResolvers.delete(id);
  }

  // ---------- chat / files / clipboard ----------

  sendChat(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const at = Date.now();
    this.send({ type: "chat", text: trimmed, at });
    this.set((s) => ({ chat: [...s.chat, { id: crypto.randomUUID(), mine: true, text: trimmed, at }] }));
  }

  offerFile(file: File, opts?: { remoteWritePath?: string; autoSaveDownload?: boolean }): void {
    if (file.size > 200 * 1024 * 1024) {
      this.set({ message: "Dosya boyutu en fazla 200 MB olabilir." });
      return;
    }
    const id = crypto.randomUUID();
    this.outgoingFile = { id, file, remoteWritePath: opts?.remoteWritePath, autoSaveDownload: opts?.autoSaveDownload };
    this.set((s) => ({
      transfers: [...s.transfers, { id, name: file.name, size: file.size, direction: "out", state: "offered", received: 0 }]
    }));
    this.send({
      type: "file-offer",
      id,
      name: file.name,
      size: file.size,
      mime: file.type,
      remoteWritePath: opts?.remoteWritePath,
      autoSaveDownload: opts?.autoSaveDownload
    });
  }

  // ---------- remote file manager (viewer browses the host's disk) ----------

  /** Lists a folder on the connected host, or its drives when `dirPath` is null. */
  listRemoteDir(dirPath: string | null): Promise<{ entries: FsEntry[]; error?: string }> {
    return new Promise((resolve) => {
      if (this.channel?.readyState !== "open") {
        resolve({ entries: [], error: "Aktif oturum yok." });
        return;
      }
      const reqId = crypto.randomUUID();
      const timer = window.setTimeout(() => {
        this.fsListResolvers.delete(reqId);
        resolve({ entries: [], error: "Zaman aşımı." });
      }, 12_000);
      this.fsListResolvers.set(reqId, (r) => {
        window.clearTimeout(timer);
        resolve(r);
      });
      this.send({ type: "fs-list", reqId, path: dirPath });
    });
  }

  /** Viewer-only: draws a live annotation stroke onto the host's real screen (see overlay.js). */
  sendAnnotation(strokeId: string, x: number, y: number, phase: "start" | "move" | "end"): void {
    if (this.get().role !== "viewer") return;
    this.send({ type: "annotate", strokeId, x, y, phase });
  }

  /** Asks the host to stream a file by path; it arrives as an auto-saved download (Downloads folder). */
  downloadRemoteFile(remotePath: string): void {
    if (this.channel?.readyState !== "open") {
      this.set({ message: "Aktif oturum yok." });
      return;
    }
    this.send({ type: "fs-download", reqId: crypto.randomUUID(), path: remotePath });
  }

  /** Picks a local file and uploads it straight into a folder on the connected host. */
  async uploadToRemoteDir(remoteDir: string): Promise<void> {
    const picked = await window.kenetControl.pickFile?.();
    if (!picked?.ok || !picked.path) return;
    const read = await window.kenetControl.readFileForTransfer?.(picked.path);
    if (!read?.ok || !read.data || !read.name) {
      this.set({ message: read?.error ?? "Dosya okunamadı." });
      return;
    }
    const file = new File([read.data], read.name);
    this.offerFile(file, { remoteWritePath: remoteDir });
  }

  /**
   * Pushes the files currently on this PC's OS clipboard onto the remote PC's clipboard,
   * so a plain Ctrl+V there drops real files — mirroring a native copy/paste. Windows only.
   */
  async sendClipboardFiles(): Promise<void> {
    if (this.channel?.readyState !== "open") {
      this.set({ message: "Aktif oturum yok." });
      return;
    }
    const list = (await window.kenetControl.listClipboardFiles?.()) ?? [];
    if (!list.length) {
      this.set({ message: "Panoda dosya yok — önce bir dosyayı kopyalayın." });
      return;
    }
    const totalBytes = list.reduce((n, f) => n + f.size, 0);
    if (totalBytes > 200 * 1024 * 1024) {
      this.set({ message: "Pano içeriği çok büyük (200 MB üzeri)." });
      return;
    }

    const batch = crypto.randomUUID();
    this.send({ type: "clipboard-files-begin", batch, count: list.length });
    this.set({ message: `${list.length} dosya panodan gönderiliyor…` });

    for (const entry of list) {
      const content = await window.kenetControl.readClipboardFile?.(entry.path);
      if (!content) continue;
      const file = new File([content.data], content.name);
      await this.sendOneFile(file, batch);
    }
  }

  private sendOneFile(file: File, clipboardBatch: string): Promise<void> {
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      this.outgoingResolvers.set(id, resolve);
      this.outgoingFile = { id, file, clipboardBatch };
      this.send({ type: "file-offer", id, name: file.name, size: file.size, mime: file.type, clipboardBatch });
    });
  }

  respondToFile(id: string, accepted: boolean): void {
    this.send({ type: "file-decision", id, accepted });
    if (!accepted) {
      this.updateTransfer(id, { state: "rejected" });
      this.incoming = undefined;
    } else {
      this.updateTransfer(id, { state: "active" });
    }
  }

  private async streamOutgoingFile(id: string): Promise<void> {
    const pending = this.outgoingFile;
    if (!pending || pending.id !== id || this.channel?.readyState !== "open") return;
    const silent = Boolean(pending.clipboardBatch);
    if (!silent) this.updateTransfer(id, { state: "active" });
    const { file } = pending;
    for (let offset = 0; offset < file.size; offset += CHUNK) {
      while (this.channel.bufferedAmount > 8 * CHUNK) await new Promise((r) => setTimeout(r, 40));
      const buf = await file.slice(offset, offset + CHUNK).arrayBuffer();
      this.channel.send(buf);
      if (!silent) this.updateTransfer(id, { received: Math.min(file.size, offset + CHUNK) });
    }
    this.send({ type: "file-end", id });
    if (!silent) this.updateTransfer(id, { state: "done", received: file.size });
    audit("file-sent", file.name);
    this.outgoingFile = undefined;
    this.resolveOutgoing(id);
  }

  private finishIncomingFile(): void {
    if (!this.incoming) return;
    const file = this.incoming;
    this.incoming = undefined;

    if (file.clipboardBatch) {
      void this.stageClipboardIncomingFile(file);
      return;
    }

    if (file.remoteWritePath) {
      void (async () => {
        const blob = new Blob(file.chunks, { type: file.mime });
        const buffer = await blob.arrayBuffer();
        const result = await window.kenetControl.writeFileToDir?.(file.remoteWritePath!, file.name, buffer);
        this.updateTransfer(file.id, { state: result?.ok ? "done" : "rejected", received: file.size });
        this.set({ message: result?.ok ? `${file.name} yüklendi.` : result?.error ?? "Dosya yazılamadı." });
        audit("file-received", file.name);
      })();
      return;
    }

    if (file.autoSaveDownload) {
      void (async () => {
        const blob = new Blob(file.chunks, { type: file.mime });
        const buffer = await blob.arrayBuffer();
        const result = await window.kenetControl.saveToDownloads?.(file.name, buffer);
        this.updateTransfer(file.id, { state: result?.saved ? "done" : "rejected", received: file.size });
        this.set({
          message: result?.saved ? `${file.name} İndirilenler klasörüne kaydedildi.` : "Dosya kaydedilemedi."
        });
        audit("file-received", file.name);
      })();
      return;
    }

    const blob = new Blob(file.chunks, { type: file.mime });
    void blob.arrayBuffer().then(async (buffer) => {
      const saver = window.kenetControl.saveIncomingFile;
      if (saver) {
        const result = await saver(file.name, buffer);
        if (result.saved) {
          this.updateTransfer(file.id, { state: "done", received: file.size });
          this.set({ message: `${file.name} kaydedildi.` });
          audit("file-received", file.name);
        } else {
          this.updateTransfer(file.id, { state: "rejected" });
          this.set({ message: "Dosya kaydı iptal edildi." });
        }
        return;
      }
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = file.name;
      link.click();
      URL.revokeObjectURL(link.href);
      this.updateTransfer(file.id, { state: "done", received: file.size });
      audit("file-received", file.name);
    });
  }

  private updateTransfer(id: string, patch: Partial<Transfer>): void {
    this.set((s) => ({ transfers: s.transfers.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
  }

  private async stageClipboardIncomingFile(file: {
    name: string;
    mime: string;
    chunks: ArrayBuffer[];
    clipboardBatch?: string;
  }): Promise<void> {
    const batch = file.clipboardBatch!;
    const blob = new Blob(file.chunks, { type: file.mime });
    const buffer = await blob.arrayBuffer();
    const staged = await window.kenetControl.stageClipboardFile?.(batch, file.name, buffer);
    if (!staged) return;

    const entry = this.clipboardIncoming.get(batch);
    if (!entry) return;
    entry.staged.push(staged);
    if (entry.staged.length < entry.total) return;

    this.clipboardIncoming.delete(batch);
    const ok = (await window.kenetControl.commitClipboardFiles?.(entry.staged)) ?? false;
    this.set({
      message: ok
        ? `${entry.total} dosya panona kondu — Ctrl+V ile yapıştırabilirsin.`
        : "Dosyalar alındı ama panoya konamadı."
    });
    if (ok) this.send({ type: "clipboard-files-ready", batch, count: entry.total });
    audit("file-received", `${entry.total} dosya (pano)`);
  }

  async syncClipboard(): Promise<void> {
    try {
      const text = (await window.kenetControl.readClipboard?.()) ?? (await navigator.clipboard.readText());
      if (text) this.send({ type: "clipboard", text });
    } catch {
      this.set({ message: "Pano okunamadı." });
    }
  }

  // ---------- control ----------

  setControlActive(active: boolean): void {
    this.set({ controlActive: active });
  }

  sendControl(command: ControlCommand): void {
    if (this.get().role === "viewer" && this.get().controlActive) this.send({ type: "control", command });
  }

  setControlOffered(on: boolean): void {
    if (this.get().role !== "host") return;
    this.set({ controlOffered: on });
  }

  /**
   * Host-only "gizlilik modu": blanks this machine's own monitor and blocks its local
   * keyboard/mouse for as long as it's on — Ctrl+Alt+Del still always works (a Windows
   * guarantee), and it's always force-disabled the moment the session ends.
   */
  async setPrivacyMode(on: boolean): Promise<void> {
    if (this.get().role !== "host") return;
    const result = await window.kenetControl.setPrivacyMode?.(on);
    if (result?.ok) this.set({ privacyActive: on });
  }

  // ---------- quality / screens ----------

  requestQuality(mode: "auto" | "sharp" | "smooth"): void {
    this.send({ type: "quality", mode });
  }

  private async applyQuality(mode: "auto" | "sharp" | "smooth"): Promise<void> {
    const sender = this.pc?.getSenders().find((s) => s.track?.kind === "video");
    if (!sender) return;
    const params = sender.getParameters();
    params.encodings = params.encodings?.length ? params.encodings : [{}];
    const enc = params.encodings[0];
    if (mode === "sharp") {
      enc.maxBitrate = 8_000_000;
      enc.maxFramerate = 20;
      enc.scaleResolutionDownBy = 1;
    } else if (mode === "smooth") {
      enc.maxBitrate = 2_500_000;
      enc.maxFramerate = 45;
      enc.scaleResolutionDownBy = 1.5;
    } else {
      enc.maxBitrate = 5_000_000;
      enc.maxFramerate = 30;
      enc.scaleResolutionDownBy = 1;
    }
    try {
      await sender.setParameters(params);
    } catch {
      /* browser rejected encoding change */
    }
  }

  /**
   * A short code both sides can read out loud and compare. It's derived from the two DTLS
   * certificate fingerprints WebRTC already negotiated for this exact connection — if a MITM were
   * relaying two separate connections instead of one direct link, each side would be looking at a
   * different pair of certificates and would compute a DIFFERENT code. Nothing here changes the
   * encryption (WebRTC is already end-to-end); this only makes it checkable instead of invisible.
   */
  async getSafetyCode(): Promise<string | null> {
    if (!this.pc) return null;
    try {
      const stats = await this.pc.getStats();
      let transport: { localCertificateId?: string; remoteCertificateId?: string } | undefined;
      stats.forEach((report: { type: string }) => {
        if (report.type === "transport") transport = report as typeof transport;
      });
      if (!transport?.localCertificateId || !transport.remoteCertificateId) return null;
      const local = stats.get(transport.localCertificateId) as { fingerprint?: string } | undefined;
      const remote = stats.get(transport.remoteCertificateId) as { fingerprint?: string } | undefined;
      if (!local?.fingerprint || !remote?.fingerprint) return null;

      const [a, b] = [local.fingerprint, remote.fingerprint].sort();
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${a}|${b}`));
      const hex = Array.from(new Uint8Array(digest))
        .map((n) => n.toString(16).padStart(2, "0"))
        .join("");
      return (hex.slice(0, 12).toUpperCase().match(/.{1,4}/g) ?? []).join(" ");
    } catch {
      return null;
    }
  }

  // ---------- session recording (local-only: whatever this side is seeing, saved to its own disk) ----------

  /** Records this side's own view of the session (host: its shared screen; viewer: the incoming
   *  video) straight to a local .webm file, streamed to disk in chunks so long sessions don't
   *  balloon in renderer memory. Nothing about this touches the peer or the signalling server. */
  async startRecording(): Promise<{ ok: boolean; error?: string }> {
    if (this.recorder) return { ok: false, error: "Zaten kayıt yapılıyor." };
    const stream = this.get().role === "host" ? this.localStream : (this.get().remoteStream ?? undefined);
    if (!stream) return { ok: false, error: "Kaydedilecek görüntü yok." };

    const name = `Kenet-${(this.get().peerName ?? "oturum").replace(/[^\w-]+/g, "_")}-${Date.now()}`;
    const started = await window.kenetControl.startRecording?.(name);
    if (!started?.ok) return { ok: false, error: started?.error ?? "Kayıt dosyası oluşturulamadı." };

    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
      ? "video/webm;codecs=vp9,opus"
      : "video/webm";
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 4_000_000 });
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) void e.data.arrayBuffer().then((buf) => window.kenetControl.recordingChunk?.(buf));
    };
    recorder.start(3000); // flush a chunk to disk every 3s instead of buffering the whole thing
    this.recorder = recorder;
    this.set({ recordingActive: true, message: "Kayıt başladı." });
    return { ok: true };
  }

  async stopRecording(): Promise<{ path?: string }> {
    if (!this.recorder) return {};
    await new Promise<void>((resolve) => {
      this.recorder!.onstop = () => resolve();
      this.recorder!.stop();
    });
    this.recorder = undefined;
    this.set({ recordingActive: false });
    const result = await window.kenetControl.stopRecording?.();
    if (result?.path) this.set({ message: `Kayıt kaydedildi: ${result.path}` });
    return { path: result?.path };
  }

  pickRemoteScreen(id: string): void {
    this.send({ type: "screen-pick", id });
  }

  private async switchScreen(id: string): Promise<void> {
    if (this.get().role !== "host") return;
    try {
      await window.kenetControl.setPreferredScreen?.(id);
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
      const nextTrack = stream.getVideoTracks()[0];
      const sender = this.pc?.getSenders().find((s) => s.track?.kind === "video");
      if (sender && nextTrack) {
        await sender.replaceTrack(nextTrack);
        this.localStream?.getVideoTracks().forEach((t) => t.stop());
        this.localStream = stream;
      }
    } catch {
      this.set({ message: "Monitör değiştirilemedi." });
    }
  }

  // ---------- teardown ----------

  endSession(reason = "Oturum sonlandırıldı."): void {
    if (this.get().phase === "active" || this.get().phase === "reconnecting") this.logActivity("session-end");
    // Tell the peer this is intentional so it returns to idle immediately instead of burning
    // ~20s on reconnect attempts. Best-effort — if the channel's already gone, the peer falls
    // back to its normal drop detection.
    if (reason !== "Karşı taraf oturumu sonlandırdı.") this.send({ type: "bye" });
    if (this.get().privacyActive) void window.kenetControl.setPrivacyMode?.(false);
    if (this.get().role === "host") void window.kenetControl.hideOverlay?.();
    if (this.recorder) void this.stopRecording();
    this.stopClipboardSync();
    this.stopIdleWatch();
    this.peerDeviceId = undefined;
    this.probe?.stop();
    this.probe = undefined;
    this.channel?.close();
    this.channel = undefined;
    this.pc?.close();
    this.pc = undefined;
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = undefined;
    this.incoming = undefined;
    this.outgoingFile = undefined;
    this.outgoingResolvers.clear();
    this.clipboardIncoming.clear();
    this.fsListResolvers.clear();
    this.reconnectAttempts = 0;
    if (this.reconnectDeadline !== undefined) {
      window.clearTimeout(this.reconnectDeadline);
      this.reconnectDeadline = undefined;
    }
    this.gradeHistory = [];
    this.autoQuality = "auto";
    audit("session-ended", this.get().peerName ?? "cihaz");
    this.set({
      phase: this.get().registered ? "online" : "offline",
      role: "idle",
      peerRoute: null,
      peerName: null,
      remoteStream: null,
      controlOffered: false,
      controlActive: false,
      privacyActive: false,
      recordingActive: false,
      unattendedSession: false,
      startedAt: null,
      stats: emptyStats,
      quality: "warn",
      transfers: [],
      chat: [],
      message: reason
    });
  }
}

export const session = new SessionController();
if (import.meta.env.DEV || localStorage.getItem("__rd_debug") === "1") {
  (window as unknown as { kenetSession?: SessionController }).kenetSession = session;
}
