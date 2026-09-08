import type { CodecChoice } from "./probe";
import type { ChunkFrame, DecoderConfigMsg } from "./wire";
import { KeyframeScheduler } from "./cadence";

export interface EncoderStats {
  fps: number;
  bitrateKbps: number;
  queue: number;
  dropped: number;
  width: number;
  height: number;
  codec: string;
  hardware: boolean;
}

export interface ScreenEncoderHooks {
  onConfig: (cfg: DecoderConfigMsg) => void;
  onChunk: (frame: ChunkFrame) => void;
  onStats?: (s: EncoderStats) => void;
  onError?: (err: Error) => void;
  onDiag?: (line: string) => void;
}

interface RateTarget {
  bitrate: number;
  framerate: number;
}

const MAX_QUEUE = 8; // frames in flight before we start dropping (software encode bursts)

/** Encoders want even, not-tiny dimensions; a 3px window mid-resize otherwise crashes them. */
export const clampDim = (n: number): number => {
  const v = Math.max(64, Math.round(n || 0));
  return v - (v % 2);
};

/**
 * Host side of the WebCodecs video path: pulls VideoFrames off the shared-screen track, encodes
 * them with a (preferably GPU) VideoEncoder, and hands each EncodedVideoChunk to `onChunk` for the
 * data channel. Falls over loudly via `onError` so session.ts can drop back to WebRTC video.
 */
export class ScreenEncoder {
  private encoder: VideoEncoder | undefined;
  private reader: ReadableStreamDefaultReader<VideoFrame> | undefined;
  private captureVideo: HTMLVideoElement | undefined;
  private captureTimer: number | undefined;
  private running = false;
  private readonly keyframes = new KeyframeScheduler(2000);
  private target: RateTarget = { bitrate: 8_000_000, framerate: 30 };
  private choice: CodecChoice | undefined;
  private width = 0;
  private height = 0;
  private srcWidth = 0;
  private srcHeight = 0;
  private preferHardware = false;
  private captureKind: "trackprocessor" | "video-element" = "trackprocessor";
  /** encode at 1 / scale of the captured resolution — raised when the encoder can't keep 25 fps */
  private scale = 1;
  private lastEncodeMs = 0;
  private lastConfigMs = 0;
  private lastConfigJson = "";
  private lastAdaptMs = 0;
  private encodedInWindow = 0;
  private resizeDebounce: number | undefined;
  private statsTimer: number | undefined;

  // rolling stats
  private bytesSinceStat = 0;
  private framesSinceStat = 0;
  private dropped = 0;

  constructor(private readonly hooks: ScreenEncoderHooks) {}

  async start(
    track: MediaStreamTrack,
    choice: CodecChoice,
    initial: RateTarget,
    opts: { hardware?: boolean } = {}
  ): Promise<void> {
    if (typeof VideoEncoder === "undefined") throw new Error("WebCodecs VideoEncoder unavailable");

    this.choice = choice;
    this.target = { ...initial };
    this.preferHardware = opts.hardware ?? false;
    // Software encoders can't do 30 fps at native laptop-panel resolution — start already scaled
    // down and let adapt() walk it back toward 1:1 if the CPU turns out to have headroom.
    this.scale = opts.hardware ? 1 : 1.5;
    const s = track.getSettings();
    this.srcWidth = clampDim(s.width ?? 1280);
    this.srcHeight = clampDim(s.height ?? 720);
    this.applyScale();

    this.encoder = new VideoEncoder({
      output: (chunk, meta) => this.onEncoded(chunk, meta),
      error: (e) => {
        this.stop();
        this.hooks.onError?.(e instanceof Error ? e : new Error(String(e)));
      }
    });
    this.configureEncoder(true);
    this.running = true;

    const Processor = (globalThis as typeof globalThis & { MediaStreamTrackProcessor?: typeof MediaStreamTrackProcessor })
      .MediaStreamTrackProcessor;
    if (Processor) {
      // Best path — reads frames straight off the track, unaffected by window visibility.
      this.captureKind = "trackprocessor";
      const proc = new Processor({ track });
      this.reader = (proc.readable as ReadableStream<VideoFrame>).getReader();
      void this.pump();
    } else {
      this.captureKind = "video-element";
      await this.startVideoElementCapture(track);
    }
    this.hooks.onDiag?.(`capture: ${this.captureKind}`);

    this.statsTimer = window.setInterval(() => this.emitStats(), 1000);
  }

  private async startVideoElementCapture(track: MediaStreamTrack): Promise<void> {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([track]);
    this.captureVideo = video;
    await video.play().catch(() => {});
    // Deliberately NOT requestVideoFrameCallback: it stops firing when the host window is
    // minimised/occluded, which freezes the whole stream. A plain timer keeps running (the app
    // sets disable-background-timer-throttling), and screen content tolerates a fixed cadence.
    this.captureTimer = window.setInterval(() => {
      if (!this.running || !this.captureVideo) return;
      if (video.readyState < 2 || !video.videoWidth) return;
      let frame: VideoFrame | undefined;
      try {
        frame = new VideoFrame(video, { timestamp: performance.now() * 1000 });
        this.consume(frame);
      } catch {
        /* transient — between play() and first decoded frame */
      } finally {
        frame?.close();
      }
    }, 1000 / 30);
  }

  requestKeyframe(): void {
    this.keyframes.request();
  }

  setRate(bitrate: number, framerate: number): void {
    // Reconfigure is expensive and, done too often, crashes hardware encoders — only when the
    // bitrate really moved and not more than once every 4s.
    const bChange = Math.abs(bitrate - this.target.bitrate) / Math.max(1, this.target.bitrate) > 0.25;
    this.target = { bitrate, framerate }; // framerate is enforced in consume(), no reconfigure
    if (bChange && performance.now() - this.lastConfigMs > 4000) {
      try {
        this.configureEncoder(false);
      } catch {
        /* keep the last good config */
      }
    }
  }

  stop(): void {
    this.running = false;
    if (this.statsTimer !== undefined) window.clearInterval(this.statsTimer);
    this.statsTimer = undefined;
    if (this.resizeDebounce !== undefined) window.clearTimeout(this.resizeDebounce);
    this.resizeDebounce = undefined;
    if (this.captureTimer !== undefined) window.clearInterval(this.captureTimer);
    this.captureTimer = undefined;
    void this.reader?.cancel().catch(() => {});
    this.reader = undefined;
    if (this.captureVideo) {
      this.captureVideo.srcObject = null;
      this.captureVideo = undefined;
    }
    try {
      if (this.encoder && this.encoder.state !== "closed") this.encoder.close();
    } catch {
      /* already closed */
    }
    this.encoder = undefined;
  }

  private applyScale(): void {
    this.width = clampDim(this.srcWidth / this.scale);
    this.height = clampDim(this.srcHeight / this.scale);
  }

  private reconfigureSafely(): void {
    try {
      this.configureEncoder(false);
    } catch (e) {
      this.hooks.onError?.(e instanceof Error ? e : new Error(String(e)));
    }
  }

  /** Once per second: nudge the encode resolution so we hold ~25 fps on whatever CPU this is. */
  private adapt(): void {
    const fps = this.encodedInWindow;
    this.encodedInWindow = 0;
    const now = performance.now();
    if (now - this.lastAdaptMs < 3000) return;
    const queueOk = (this.encoder?.encodeQueueSize ?? 0) < MAX_QUEUE - 1;
    if (fps < 20 && this.scale < 3) {
      this.scale = Math.min(3, this.scale + 0.5);
    } else if (fps >= 27 && queueOk && this.scale > 1) {
      this.scale = Math.max(1, this.scale - 0.5);
    } else {
      return;
    }
    this.lastAdaptMs = now;
    this.applyScale();
    this.reconfigureSafely();
  }

  private configureEncoder(first: boolean): void {
    if (!this.encoder || !this.choice) return;
    this.lastConfigMs = performance.now();
    const w = clampDim(this.width);
    const h = clampDim(this.height);
    const base = {
      width: w,
      height: h,
      bitrate: this.target.bitrate,
      framerate: this.target.framerate,
      latencyMode: "realtime" as const,
      // "prefer-hardware" on a machine whose GPU can't encode this codec throws "Encoder creation
      // error" instead of falling back — only ask for hardware when we negotiated it.
      hardwareAcceleration: (this.preferHardware ? "prefer-hardware" : "no-preference") as HardwareAcceleration
    };
    const withAvc = this.choice.avcFormat === "avc" ? { avc: { format: "avc" as const } } : {};
    // Try the precise codec string, then the bare family name (lets Chromium pick a level).
    const bare = /^avc1/.test(this.choice.codec) ? "avc1.42E028" : /^vp09/.test(this.choice.codec) ? "vp8" : this.choice.codec;
    try {
      this.encoder.configure({ codec: this.choice.codec, ...base, ...withAvc });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[videopipe] encoder.configure(${this.choice.codec}) failed, retrying as ${bare}:`, e);
      this.choice = { ...this.choice, codec: bare, avcFormat: /^avc1/.test(bare) ? "avc" : undefined };
      this.encoder.configure({
        codec: bare,
        ...base,
        ...(this.choice.avcFormat === "avc" ? { avc: { format: "avc" as const } } : {})
      });
    }
    if (!first) this.keyframes.request(); // reconfigure → next frame should be a keyframe
  }

  private async pump(): Promise<void> {
    while (this.running && this.reader) {
      let frame: VideoFrame | undefined;
      try {
        const r = await this.reader.read();
        if (r.done) break;
        frame = r.value;
      } catch {
        break;
      }
      try {
        this.consume(frame);
      } finally {
        frame.close();
      }
    }
  }

  private consume(frame: VideoFrame): void {
    if (!this.encoder || this.encoder.state !== "configured") return;

    const now = performance.now();
    const minGap = 1000 / Math.max(1, this.target.framerate) - 2; // -2ms slack
    if (now - this.lastEncodeMs < minGap) return; // framerate throttle (capture may run faster)

    if (this.encoder.encodeQueueSize >= MAX_QUEUE) {
      this.dropped += 1;
      return; // encoder is behind — skip rather than pile up latency
    }

    // The captured resolution can change (monitor switch, DPI). VideoEncoder auto-scales the input
    // frame to its configured size, so just encode as-is and only *reconfigure* once the source
    // size has held steady for 400ms — reconfiguring per frame during a resize crashes the encoder.
    if (frame.displayWidth && frame.displayWidth !== this.srcWidth) {
      const nw = clampDim(frame.displayWidth);
      const nh = clampDim(frame.displayHeight);
      if (this.resizeDebounce !== undefined) window.clearTimeout(this.resizeDebounce);
      this.resizeDebounce = window.setTimeout(() => {
        this.resizeDebounce = undefined;
        if (nw === this.srcWidth) return;
        this.srcWidth = nw;
        this.srcHeight = nh;
        this.applyScale();
        this.reconfigureSafely();
      }, 400);
    }

    try {
      const key = this.keyframes.due(now);
      this.encoder.encode(frame, { keyFrame: key });
      this.encodedInWindow += 1;
      this.lastEncodeMs = now;
    } catch {
      /* encoder not ready between (re)configures — skip this frame */
    }
  }

  private onEncoded(chunk: EncodedVideoChunk, meta: EncodedVideoChunkMetadata | undefined): void {
    if (meta?.decoderConfig) {
      const dc = meta.decoderConfig;
      const msg: DecoderConfigMsg = {
        codec: dc.codec,
        codedWidth: dc.codedWidth ?? this.width,
        codedHeight: dc.codedHeight ?? this.height,
        description: dc.description ? new Uint8Array(toArrayBuffer(dc.description)) : undefined
      };
      const json = JSON.stringify({ ...msg, description: msg.description ? [...msg.description] : null });
      if (json !== this.lastConfigJson) {
        this.lastConfigJson = json;
        this.hooks.onConfig(msg);
      }
    }
    if (chunk.type === "key") this.keyframes.noteKeyframe(performance.now());

    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    this.bytesSinceStat += data.byteLength;
    this.framesSinceStat += 1;
    this.hooks.onChunk({
      key: chunk.type === "key",
      timestamp: chunk.timestamp,
      duration: chunk.duration ?? 0,
      data
    });
  }

  private emitStats(): void {
    this.adapt();
    if (!this.hooks.onStats) return;
    const fps = this.framesSinceStat;
    const bitrateKbps = Math.round((this.bytesSinceStat * 8) / 1000);
    this.framesSinceStat = 0;
    this.bytesSinceStat = 0;
    this.hooks.onStats({
      fps,
      bitrateKbps,
      queue: this.encoder?.encodeQueueSize ?? 0,
      dropped: this.dropped,
      width: this.width,
      height: this.height,
      codec: this.choice?.label ?? "?",
      hardware: this.preferHardware
    });
  }
}

const toArrayBuffer = (d: AllowSharedBufferSource): ArrayBuffer => {
  if (d instanceof ArrayBuffer) return d;
  const view = d as ArrayBufferView;
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
};
