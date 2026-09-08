import { describe, expect, it } from "vitest";
import { KeyframeScheduler } from "./cadence";

describe("KeyframeScheduler", () => {
  it("forces a keyframe on the very first frame", () => {
    const k = new KeyframeScheduler(2000);
    expect(k.due(1000)).toBe(true);
  });

  it("then holds off until the period elapses", () => {
    const k = new KeyframeScheduler(2000);
    k.due(0);
    expect(k.due(500)).toBe(false);
    expect(k.due(1999)).toBe(false);
    expect(k.due(2000)).toBe(true);
  });

  it("honours an explicit request immediately", () => {
    const k = new KeyframeScheduler(2000);
    k.due(0);
    k.request();
    expect(k.due(100)).toBe(true);
    expect(k.due(150)).toBe(false); // request consumed
  });

  it("request-only mode never fires periodically", () => {
    const k = new KeyframeScheduler(0);
    expect(k.due(0)).toBe(true); // first frame still keyed
    for (let t = 100; t < 100_000; t += 500) expect(k.due(t)).toBe(false);
    k.request();
    expect(k.due(100_500)).toBe(true);
  });

  it("noteKeyframe resets the periodic clock", () => {
    const k = new KeyframeScheduler(2000);
    k.due(0);
    k.noteKeyframe(1800); // encoder emitted its own key at 1800
    expect(k.due(2100)).toBe(false); // only 300ms since the real last key
    expect(k.due(3800)).toBe(true);
  });
});
