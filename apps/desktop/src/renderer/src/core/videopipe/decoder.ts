import type { ChunkFrame, DecoderConfigMsg } from "./wire";
import { DecodeGate, Nagger } from "./gate";

export interface DecoderStats {
  fps: number;
  dropped: number;
  width: number;
  height: number;
}

export interface ScreenDecoderHooks {
  /** Ask the host (over the data channel) to emit a keyframe now. */
  onNeedKeyframe: () => void;
  onStats?: (s: DecoderStats) => void;
  onError?: (err: Error) => void;
  /** First successful frame after (re)configure — lets the UI hide its spinner. */
  onFirstFrame?: () => void;
}

const MAX_DECODE_QUEUE = 8;

/**
 * Viewer side of the WebCodecs video path: takes framed EncodedVideoChunks off the data channel,
 * decodes them (preferring the GPU), and paints each VideoFrame to a canvas. Gating / keyframe
 * nagging live in the pure DecodeGate + Nagger (tested separately).
 */
export class ScreenDecoder {
  private decoder: VideoDecoder | undefined;
  private canvas: HTMLCanvasElement | undefined;
  private ctx: CanvasRenderingContext2D | undefined;
  private readonly gate = new DecodeGate(MAX_DECODE_QUEUE);
  private readonly nagger = new Nagger(400);
  private gotFirst = false;
  private lastConfig: DecoderConfigMsg | undefined;
  private width = 0;
  private height = 0;
  private statsTimer: number | undefined;
  private framesSinceStat = 0;
  private dropped = 0;

  constructor(private readonly hooks: ScreenDecoderHooks) {}

  attach(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false, desynchronized: true }) ?? undefined;
  }

  start(): void {
    if (typeof VideoDecoder === "undefined") throw new Error("WebCodecs VideoDecoder unavailable");
    this.decoder = this.makeDecoder();
    this.statsTimer = window.setInterval(() => this.emitStats(), 1000);
  }

  configure(cfg: DecoderConfigMsg): void {
    if (!this.decoder) return;
    this.lastConfig = cfg;
    try {
      this.decoder.configure({
        codec: cfg.codec,
        codedWidth: cfg.codedWidth,
        codedHeight: cfg.codedHeight,
        description: cfg.description ? cfg.description.slice() : undefined,
        hardwareAcceleration: "prefer-hardware",
        optimizeForLatency: true
      });
      this.width = cfg.codedWidth;
      this.height = cfg.codedHeight;
      this.gate.onConfigure();
      this.nag(true);
    } catch (e) {
      this.hooks.onError?.(e instanceof Error ? e : new Error(String(e)));
    }
  }

  pushChunk(f: ChunkFrame): void {
    if (!this.decoder) return;
    const verdict = this.gate.admit({ key: f.key, decodeQueueSize: this.decoder.decodeQueueSize });
    if (verdict !== "decode") {
      this.dropped += 1;
      if (this.gate.needsKeyframe) this.nag(false);
      return;
    }
    try {
      this.decoder.decode(
        new EncodedVideoChunk({
          type: f.key ? "key" : "delta",
          timestamp: f.timestamp,
          duration: f.duration || undefined,
          data: f.data
        })
      );
    } catch {
      this.gate.onReset();
      this.nag(true);
    }
  }

  stop(): void {
    if (this.statsTimer !== undefined) window.clearInterval(this.statsTimer);
    this.statsTimer = undefined;
    this.close();
  }

  private makeDecoder(): VideoDecoder {
    return new VideoDecoder({
      output: (frame) => this.paint(frame),
      error: (e) => {
        this.hooks.onError?.(e instanceof Error ? e : new Error(String(e)));
        this.recover();
      }
    });
  }

  private paint(frame: VideoFrame): void {
    try {
      const w = frame.displayWidth || this.width;
      const h = frame.displayHeight || this.height;
      if (this.canvas && (this.canvas.width !== w || this.canvas.height !== h)) {
        this.canvas.width = w;
        this.canvas.height = h;
      }
      this.ctx?.drawImage(frame, 0, 0);
      this.framesSinceStat += 1;
      if (!this.gotFirst) {
        this.gotFirst = true;
        this.hooks.onFirstFrame?.();
      }
    } finally {
      frame.close();
    }
  }

  private nag(force: boolean): void {
    if (this.nagger.fire(performance.now(), force)) this.hooks.onNeedKeyframe();
  }

  private recover(): void {
    this.close();
    this.gate.onReset();
    this.decoder = this.makeDecoder();
    if (this.lastConfig) this.configure(this.lastConfig);
    else this.nag(true);
  }

  private close(): void {
    try {
      if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
    } catch {
      /* already closed */
    }
    this.decoder = undefined;
  }

  private emitStats(): void {
    if (!this.hooks.onStats) return;
    const fps = this.framesSinceStat;
    this.framesSinceStat = 0;
    this.hooks.onStats({ fps, dropped: this.dropped, width: this.width, height: this.height });
  }
}
