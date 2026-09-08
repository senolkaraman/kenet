/**
 * The WebCodecs video path rides an SCTP data channel, so there is no RTP bandwidth estimator to
 * lean on. We roll a small AIMD controller instead: the only congestion signal we have is the
 * channel's `bufferedAmount` — if it climbs and stays up, bytes are queuing faster than the link
 * drains them, so back the encoder off; if it sits near empty, there's headroom to climb back.
 *
 * Pure and deterministic so it can be unit-tested without a real channel.
 */

export interface RateBounds {
  minBitrate: number;
  maxBitrate: number;
  minFramerate: number;
  maxFramerate: number;
}

export interface RateState {
  bitrate: number;
  framerate: number;
}

export interface RateDecision extends RateState {
  changed: boolean;
  reason: "steady" | "congested" | "recovering";
}

const DEFAULT_BOUNDS: RateBounds = {
  // Below ~1.2 Mbps H.264 at 768p is unwatchable blocky mush — a low, choppy-but-legible floor
  // beats letting the controller chase a collapsing estimate down to nothing.
  minBitrate: 1_200_000,
  maxBitrate: 12_000_000,
  minFramerate: 12,
  maxFramerate: 30
};

// bufferedAmount thresholds, in bytes. Software encoders emit in bursts (keyframe + a few
// deltas), so "high" sits well above a couple of frames to avoid twitchy back-off.
const HIGH_WATER = 3 * 1024 * 1024;
const LOW_WATER = 256 * 1024;
// consecutive low-water ticks before we try to climb
const RECOVER_TICKS = 3;

export class RateController {
  private readonly bounds: RateBounds;
  private bitrate: number;
  private framerate: number;
  private lowStreak = 0;
  private lastBuffered = 0;
  private ticks = 0;
  // SCTP congestion control ramps over the first few seconds — don't read early backlog as trouble.
  private readonly graceTicks: number;

  constructor(start: RateState, bounds: Partial<RateBounds> = {}, graceTicks = 4) {
    this.bounds = { ...DEFAULT_BOUNDS, ...bounds };
    this.bitrate = clamp(start.bitrate, this.bounds.minBitrate, this.bounds.maxBitrate);
    this.framerate = clamp(start.framerate, this.bounds.minFramerate, this.bounds.maxFramerate);
    this.graceTicks = graceTicks;
  }

  get state(): RateState {
    return { bitrate: this.bitrate, framerate: this.framerate };
  }

  /** Call ~once per second with the current data-channel backlog. */
  tick(bufferedAmount: number): RateDecision {
    this.ticks += 1;
    const before = { bitrate: this.bitrate, framerate: this.framerate };
    const rising = bufferedAmount > this.lastBuffered + LOW_WATER;
    this.lastBuffered = bufferedAmount;

    if (this.ticks <= this.graceTicks) {
      return { bitrate: this.bitrate, framerate: this.framerate, changed: false, reason: "steady" };
    }

    let reason: RateDecision["reason"] = "steady";

    if (bufferedAmount > HIGH_WATER || (rising && bufferedAmount > LOW_WATER)) {
      this.lowStreak = 0;
      reason = "congested";
      if (this.bitrate > this.bounds.minBitrate) {
        this.bitrate = Math.max(this.bounds.minBitrate, Math.round(this.bitrate * 0.7));
      } else if (this.framerate > this.bounds.minFramerate) {
        this.framerate = Math.max(this.bounds.minFramerate, this.framerate - 5);
      }
    } else if (bufferedAmount < LOW_WATER) {
      this.lowStreak += 1;
      if (this.lowStreak >= RECOVER_TICKS) {
        reason = "recovering";
        this.lowStreak = 0;
        if (this.framerate < this.bounds.maxFramerate) {
          this.framerate = Math.min(this.bounds.maxFramerate, this.framerate + 5);
        } else if (this.bitrate < this.bounds.maxBitrate) {
          this.bitrate = Math.min(this.bounds.maxBitrate, Math.round(this.bitrate * 1.15));
        }
      }
    } else {
      this.lowStreak = 0;
    }

    const changed = before.bitrate !== this.bitrate || before.framerate !== this.framerate;
    return { bitrate: this.bitrate, framerate: this.framerate, changed, reason };
  }
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
