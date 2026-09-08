import { describe, expect, it } from "vitest";
import { RateController } from "./ratecontrol";

const start = { bitrate: 8_000_000, framerate: 30 };

describe("RateController", () => {
  it("stays put while the channel drains", () => {
    const rc = new RateController(start);
    for (let i = 0; i < 10; i += 1) {
      const d = rc.tick(0);
      expect(d.reason).not.toBe("congested");
    }
    // may climb (already at max fps → tries bitrate), but never above the ceiling
    expect(rc.state.bitrate).toBeLessThanOrEqual(12_000_000);
    expect(rc.state.framerate).toBe(30);
  });

  it("backs bitrate off when the backlog spikes", () => {
    const rc = new RateController(start);
    const d = rc.tick(1_500_000); // 1.5 MB queued
    expect(d.reason).toBe("congested");
    expect(d.changed).toBe(true);
    expect(rc.state.bitrate).toBeLessThan(8_000_000);
  });

  it("drops framerate only once bitrate is on the floor", () => {
    const rc = new RateController({ bitrate: 500_000, framerate: 30 }, { minBitrate: 400_000 });
    rc.tick(2_000_000); // congested, bitrate already near floor
    expect(rc.state.bitrate).toBe(400_000);
    rc.tick(2_000_000);
    expect(rc.state.framerate).toBe(25);
  });

  it("recovers after a sustained quiet period", () => {
    const rc = new RateController({ bitrate: 2_000_000, framerate: 15 });
    // one congestion event
    rc.tick(1_000_000);
    const low = rc.state;
    // three quiet ticks → should start climbing (framerate first)
    rc.tick(0);
    rc.tick(0);
    const d = rc.tick(0);
    expect(d.reason).toBe("recovering");
    expect(rc.state.framerate).toBeGreaterThan(low.framerate);
  });

  it("never oscillates on a steady mid-level backlog", () => {
    const rc = new RateController(start);
    const seen = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      rc.tick(120 * 1024); // between low and high water, not rising
      seen.add(`${rc.state.bitrate}/${rc.state.framerate}`);
    }
    expect(seen.size).toBe(1); // one stable operating point
  });
});
