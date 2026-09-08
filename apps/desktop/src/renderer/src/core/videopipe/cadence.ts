/**
 * Decides when the encoder must emit a keyframe: on an explicit request (decoder just started,
 * decode error, packet gap) and as a periodic safety net so a viewer that joins or glitches
 * mid-stream recovers without waiting forever. Pure + time-injected so it's testable.
 */
export class KeyframeScheduler {
  private lastKeyAt = -Infinity;
  private pendingRequest = false;

  /** periodMs: 0 disables the periodic safety keyframe (request-only mode) */
  constructor(private readonly periodMs = 2000) {}

  /** Call from the "I need a keyframe" data-channel message. */
  request(): void {
    this.pendingRequest = true;
  }

  /** Call once per frame with the frame's wall-clock time; returns true to encode as a keyframe. */
  due(now: number): boolean {
    const first = this.lastKeyAt === -Infinity;
    if (first || this.pendingRequest || (this.periodMs > 0 && now - this.lastKeyAt >= this.periodMs)) {
      this.pendingRequest = false;
      this.lastKeyAt = now;
      return true;
    }
    return false;
  }

  /** The encoder inserted a keyframe on its own (scene cut etc.) — keep the clock honest. */
  noteKeyframe(now: number): void {
    this.lastKeyAt = now;
    this.pendingRequest = false;
  }
}
