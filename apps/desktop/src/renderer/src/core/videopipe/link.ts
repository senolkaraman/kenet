import { ScreenEncoder, type EncoderStats } from "./encoder";
import { ScreenDecoder, type DecoderStats } from "./decoder";
import { RateController } from "./ratecontrol";
import { decideVideoPath } from "./negotiate";
import { probeLocalCaps, choiceForCodec, type LocalVideoCaps } from "./probe";
import {
  wireKind,
  packChunk,
  packConfig,
  packKeyframeRequest,
  unpackChunk,
  unpackConfig
} from "./wire";

export type VideoMode = "webrtc" | "webcodecs";

export interface VideoLinkStats {
  mode: VideoMode;
  fps: number;
  kbps: number;
  width: number;
  height: number;
  codec: string;
  hardware: boolean;
  dropped: number;
  reason?: string;
}

export interface VideoLinkHooks {
  role: "host" | "viewer";
  pc: RTCPeerConnection;
  /** send a JSON control message on the MAIN data channel */
  sendControl: (msg: Record<string, unknown>) => void;
  /** host: current screen video track */
  getScreenTrack: () => MediaStreamTrack | null;
  /** host: the RTP video sender (to pause/resume WebRTC encoding) */
  getVideoSender: () => RTCRtpSender | null;
  /** viewer: canvas to paint decoded frames into */
  getCanvas: () => HTMLCanvasElement | null;
  onMode: (mode: VideoMode, reason?: string) => void;
  onStats: (s: VideoLinkStats) => void;
  /** one-line human diagnostic for the Durum panel */
  onDiag?: (line: string) => void;
}

type CapsMsg = { type: "video-caps"; caps: LocalVideoCaps };
type ModeMsg = { type: "video-mode"; mode: VideoMode; codec?: string; from?: "host" | "viewer"; why?: string };

const START = { bitrate: 8_000_000, framerate: 30 };

/**
 * Owns the WebCodecs video path and its negotiation. session.ts creates one per session, feeds it
 * the two "vcaps"/"vmode" control messages and the "kenet-video" data channel, and otherwise stays
 * out of the way. Any failure here falls the session back to plain WebRTC video.
 */
export class VideoLink {
  private mode: VideoMode = "webrtc";
  private localCaps: LocalVideoCaps | undefined;
  private peerCaps: LocalVideoCaps | undefined;
  private encoder: ScreenEncoder | undefined;
  private decoder: ScreenDecoder | undefined;
  private videoChannel: RTCDataChannel | undefined;
  private rate = new RateController(START);
  private rateTimer: number | undefined;
  private hardware = false;
  private encStats: EncoderStats | undefined;
  private decStats: DecoderStats | undefined;
  private stopped = false;
  private decoderFailures = 0;
  private negotiatedCodec = "";
  private firstFrameWatchdog: number | undefined;
  private sawFrame = false;

  constructor(private readonly hooks: VideoLinkHooks) {}

  /** Call once the main data channel is open. */
  async start(): Promise<void> {
    const track = this.hooks.getScreenTrack();
    const s = track?.getSettings();
    this.localCaps = await probeLocalCaps(s?.width ?? 1920, s?.height ?? 1080);
    if (this.stopped) return;
    // eslint-disable-next-line no-console
    console.info(`[videopipe] ${this.hooks.role} caps`, this.localCaps);
    const encList = this.localCaps.encodeHw.length
      ? `HW ${this.localCaps.encodeHw.join(",")}`
      : this.localCaps.encodeSw.length
        ? `SW ${this.localCaps.encodeSw.join(",")}`
        : "yok";
    this.hooks.onDiag?.(`bu makine encode: ${encList}`);
    this.hooks.sendControl({ type: "video-caps", caps: this.localCaps } satisfies CapsMsg);
    this.tryNegotiate();
  }

  /** Returns true if it consumed the message. */
  onControlMessage(msg: unknown): boolean {
    const t = (msg as { type?: unknown } | null)?.type;
    if (t === "video-caps") {
      this.peerCaps = (msg as CapsMsg).caps;
      this.tryNegotiate();
      return true;
    }
    if (t === "video-mode") {
      this.applyMode(msg as ModeMsg);
      return true;
    }
    return false;
  }

  /** session.ts routes the "kenet-video" RTCDataChannel here. */
  attachVideoChannel(ch: RTCDataChannel): void {
    ch.binaryType = "arraybuffer";
    this.videoChannel = ch;
    ch.onmessage = (e) => this.onVideoData(e.data as ArrayBuffer);
    if (this.hooks.role === "viewer") this.startDecoder();
  }

  /** Host: monitor switched — hand the encoder the new track. */
  swapScreenTrack(track: MediaStreamTrack): void {
    if (this.mode !== "webcodecs" || !this.encoder) return;
    this.encoder.stop();
    this.encoder = undefined;
    if (this.rateTimer !== undefined) window.clearInterval(this.rateTimer);
    this.startEncoder(track);
  }

  stop(): void {
    this.stopped = true;
    if (this.rateTimer !== undefined) window.clearInterval(this.rateTimer);
    if (this.firstFrameWatchdog !== undefined) window.clearTimeout(this.firstFrameWatchdog);
    this.encoder?.stop();
    this.decoder?.stop();
    try {
      this.videoChannel?.close();
    } catch {
      /* ignore */
    }
    this.encoder = this.decoder = this.videoChannel = undefined;
  }

  // ---- negotiation ----

  private tryNegotiate(): void {
    if (this.hooks.role !== "host" || this.mode === "webcodecs" || !this.localCaps || !this.peerCaps) return;
    // Software WebCodecs is allowed: even without a GPU encoder, driving the bitrate ourselves
    // over SCTP beats WebRTC's screen-share BWE, which routinely collapses to a few hundred kbps.
    const decision = decideVideoPath(
      { hw: this.localCaps.encodeHw, sw: this.localCaps.encodeSw },
      { hw: this.peerCaps.decodeHw, sw: this.peerCaps.decodeSw },
      { requireHardware: false }
    );
    // eslint-disable-next-line no-console
    console.info("[videopipe] decision", decision, { hostEncodeHw: this.localCaps.encodeHw, hostEncodeSw: this.localCaps.encodeSw, viewerDecodeHw: this.peerCaps.decodeHw, viewerDecodeSw: this.peerCaps.decodeSw });
    if (decision.mode === "webrtc") {
      this.hooks.onDiag?.(
        `karar: WebRTC — ${decision.why} · host enc [${this.localCaps.encodeSw.join(",") || "-"}] · viewer dec [${this.peerCaps.decodeSw.join(",") || "-"}]`
      );
      this.hooks.sendControl({ type: "video-mode", mode: "webrtc", from: "host", why: decision.why } satisfies ModeMsg);
      this.hooks.onMode("webrtc", decision.why);
      return;
    }
    this.hooks.onDiag?.(`karar: WebCodecs ${decision.hardware ? "donanım" : "yazılım"} ${decision.codec}`);
    this.hardware = decision.hardware;
    this.rate = new RateController(decision.hardware ? { bitrate: 8_000_000, framerate: 30 } : { bitrate: 5_000_000, framerate: 24 });
    this.enterWebCodecsHost(decision.codec);
  }

  private applyMode(m: ModeMsg): void {
    if (m.mode === "webrtc") {
      if (this.mode === "webcodecs") this.fallback(m.why ?? "peer requested WebRTC");
      else this.hooks.onMode("webrtc", m.why);
      return;
    }
    // viewer receiving "webcodecs": get ready; the kenet-video channel + config follow
    if (this.hooks.role === "viewer") {
      this.mode = "webcodecs";
      this.hooks.onMode("webcodecs");
      this.startDecoder();
    }
  }

  // ---- host side ----

  private enterWebCodecsHost(codec: string): void {
    const track = this.hooks.getScreenTrack();
    const choice = choiceForCodec(codec);
    if (!track || !choice) {
      this.fallback("host lost the screen track");
      return;
    }
    this.negotiatedCodec = codec;
    try {
      this.videoChannel = this.hooks.pc.createDataChannel("kenet-video", { ordered: true });
      this.videoChannel.binaryType = "arraybuffer";
      this.videoChannel.onmessage = (e) => this.onVideoData(e.data as ArrayBuffer);
      this.videoChannel.onopen = () => this.startEncoder(track);
    } catch {
      this.fallback("could not open video channel");
      return;
    }
    void this.hooks.getVideoSender()?.replaceTrack(null).catch(() => {});
    this.mode = "webcodecs";
    this.hooks.sendControl({ type: "video-mode", mode: "webcodecs", codec, from: "host" } satisfies ModeMsg);
    this.hooks.onMode("webcodecs");
  }

  private startEncoder(track: MediaStreamTrack): void {
    if (this.stopped || !this.videoChannel) return;
    const choice = choiceForCodec(this.negotiatedCodec);
    if (!choice) return this.fallback("codec vanished");
    this.encoder = new ScreenEncoder({
      onConfig: (cfg) => this.videoChannel?.send(packConfig(cfg)),
      onChunk: (f) => {
        if (this.videoChannel && this.videoChannel.bufferedAmount < 8 * 1024 * 1024) {
          this.videoChannel.send(packChunk(f));
        }
      },
      onStats: (st) => {
        this.encStats = st;
        this.pushStats();
      },
      onError: (err) => this.fallback(`encoder: ${err.message}`)
    });
    void this.encoder.start(track, choice, this.rate.state);
    this.rateTimer = window.setInterval(() => {
      if (!this.videoChannel) return;
      const d = this.rate.tick(this.videoChannel.bufferedAmount);
      if (d.changed) this.encoder?.setRate(d.bitrate, d.framerate);
    }, 1000);
  }

  // ---- viewer side ----

  private startDecoder(): void {
    if (this.stopped || this.decoder || this.hooks.role !== "viewer") return;
    const canvas = this.hooks.getCanvas();
    if (!canvas) {
      // canvas not mounted yet — retry shortly
      window.setTimeout(() => this.startDecoder(), 60);
      return;
    }
    this.decoder = new ScreenDecoder({
      onNeedKeyframe: () => this.videoChannel?.send(packKeyframeRequest()),
      onStats: (st) => {
        this.decStats = st;
        this.pushStats();
      },
      onFirstFrame: () => {
        this.sawFrame = true;
        if (this.firstFrameWatchdog !== undefined) window.clearTimeout(this.firstFrameWatchdog);
        this.hooks.onMode("webcodecs");
      },
      onError: () => {
        this.decoderFailures += 1;
        if (this.decoderFailures >= 3) {
          this.hooks.sendControl({ type: "video-mode", mode: "webrtc", from: "viewer", why: "decoder failing" } satisfies ModeMsg);
          this.fallback("decoder failing");
        }
      }
    });
    this.decoder.attach(canvas);
    try {
      this.decoder.start();
    } catch {
      this.fallback("no WebCodecs decoder");
      return;
    }
    // Fail safe: if nothing is on the canvas within 4 s, the WebCodecs path is broken somewhere
    // the error callbacks didn't catch — drop back to WebRTC rather than sit on a black screen.
    this.firstFrameWatchdog = window.setTimeout(() => {
      if (!this.sawFrame) {
        this.hooks.sendControl({ type: "video-mode", mode: "webrtc", from: "viewer", why: "no frames" } satisfies ModeMsg);
        this.fallback("no frames in 4s");
      }
    }, 4000);
  }

  private onVideoData(data: ArrayBuffer): void {
    const kind = wireKind(data);
    if (this.hooks.role === "host") {
      if (kind === "keyframe-request") this.encoder?.requestKeyframe();
      return;
    }
    if (!this.decoder) this.startDecoder();
    if (kind === "config") this.decoder?.configure(unpackConfig(data));
    else if (kind === "chunk") this.decoder?.pushChunk(unpackChunk(data));
  }

  // ---- fallback ----

  private fallback(reason: string): void {
    if (this.mode === "webrtc") return;
    this.mode = "webrtc";
    if (this.rateTimer !== undefined) window.clearInterval(this.rateTimer);
    if (this.firstFrameWatchdog !== undefined) window.clearTimeout(this.firstFrameWatchdog);
    this.encoder?.stop();
    this.decoder?.stop();
    this.encoder = this.decoder = undefined;
    if (this.hooks.role === "host") {
      const track = this.hooks.getScreenTrack();
      if (track) void this.hooks.getVideoSender()?.replaceTrack(track).catch(() => {});
      this.hooks.sendControl({ type: "video-mode", mode: "webrtc", from: "host", why: reason } satisfies ModeMsg);
    }
    try {
      this.videoChannel?.close();
    } catch {
      /* ignore */
    }
    this.videoChannel = undefined;
    this.hooks.onMode("webrtc", reason);
  }

  private pushStats(): void {
    if (this.mode !== "webcodecs") return;
    const e = this.encStats;
    const d = this.decStats;
    this.hooks.onStats({
      mode: "webcodecs",
      fps: (this.hooks.role === "host" ? e?.fps : d?.fps) ?? 0,
      kbps: e?.bitrateKbps ?? 0,
      width: (this.hooks.role === "host" ? e?.width : d?.width) ?? 0,
      height: (this.hooks.role === "host" ? e?.height : d?.height) ?? 0,
      codec: e?.codec ?? choiceForCodec(this.negotiatedCodec)?.label ?? "",
      hardware: this.hardware,
      dropped: (this.hooks.role === "host" ? e?.dropped : d?.dropped) ?? 0
    });
  }
}
