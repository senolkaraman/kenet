/**
 * Pure decision logic for the decoder's input side, split out so it can be tested without
 * WebCodecs: what to do with each incoming chunk given whether we're configured, whether we've
 * seen a keyframe since the last (re)configure, and how deep the decode queue is.
 */

export type GateVerdict =
  | "decode" //  hand it to the decoder
  | "drop-not-ready" //  no config yet — ignore, ask for keyframe
  | "drop-need-key" //  configured but still waiting for the first keyframe
  | "drop-behind"; //  decoder is backed up — skip this delta

export interface GateInput {
  key: boolean;
  decodeQueueSize: number;
}

export class DecodeGate {
  private configured = false;
  private awaitingKey = true;

  constructor(private readonly maxQueue = 8) {}

  onConfigure(): void {
    this.configured = true;
    this.awaitingKey = true;
  }

  /** The decoder threw / reset — force a fresh keyframe before anything else. */
  onReset(): void {
    this.awaitingKey = true;
  }

  admit(input: GateInput): GateVerdict {
    if (!this.configured) return "drop-not-ready";
    if (this.awaitingKey && !input.key) return "drop-need-key";
    if (!input.key && input.decodeQueueSize >= this.maxQueue) return "drop-behind";
    if (input.key) this.awaitingKey = false;
    return "decode";
  }

  get needsKeyframe(): boolean {
    return !this.configured || this.awaitingKey;
  }
}

/** Rate-limits the "send me a keyframe" nag so a burst of unusable frames = one request. */
export class Nagger {
  private lastMs = -Infinity;
  constructor(private readonly minGapMs = 400) {}

  /** Returns true if the caller should actually send the request now. */
  fire(now: number, force = false): boolean {
    if (!force && now - this.lastMs < this.minGapMs) return false;
    this.lastMs = now;
    return true;
  }
}
