import { describe, expect, it } from "vitest";
import { DecodeGate, Nagger } from "./gate";

describe("DecodeGate", () => {
  it("drops everything until configured", () => {
    const g = new DecodeGate();
    expect(g.admit({ key: true, decodeQueueSize: 0 })).toBe("drop-not-ready");
    expect(g.needsKeyframe).toBe(true);
  });

  it("after configure, drops deltas until the first keyframe", () => {
    const g = new DecodeGate();
    g.onConfigure();
    expect(g.admit({ key: false, decodeQueueSize: 0 })).toBe("drop-need-key");
    expect(g.admit({ key: true, decodeQueueSize: 0 })).toBe("decode");
    expect(g.admit({ key: false, decodeQueueSize: 0 })).toBe("decode");
    expect(g.needsKeyframe).toBe(false);
  });

  it("skips deltas when the decode queue is deep, but never a keyframe", () => {
    const g = new DecodeGate(4);
    g.onConfigure();
    g.admit({ key: true, decodeQueueSize: 0 });
    expect(g.admit({ key: false, decodeQueueSize: 4 })).toBe("drop-behind");
    expect(g.admit({ key: false, decodeQueueSize: 9 })).toBe("drop-behind");
    expect(g.admit({ key: true, decodeQueueSize: 9 })).toBe("decode");
  });

  it("a reset re-arms the keyframe wait", () => {
    const g = new DecodeGate();
    g.onConfigure();
    g.admit({ key: true, decodeQueueSize: 0 });
    g.onReset();
    expect(g.needsKeyframe).toBe(true);
    expect(g.admit({ key: false, decodeQueueSize: 0 })).toBe("drop-need-key");
  });
});

describe("Nagger", () => {
  it("collapses a burst into one request", () => {
    const n = new Nagger(400);
    expect(n.fire(0)).toBe(true);
    expect(n.fire(100)).toBe(false);
    expect(n.fire(399)).toBe(false);
    expect(n.fire(400)).toBe(true);
  });

  it("force bypasses the rate limit", () => {
    const n = new Nagger(400);
    n.fire(0);
    expect(n.fire(50, true)).toBe(true);
  });
});
