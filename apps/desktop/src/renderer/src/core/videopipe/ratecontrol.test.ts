import { describe, expect, it } from "vitest";
import { RateController } from "./ratecontrol";

const start = { bitrate: 8_000_000, framerate: 30 };
// graceTicks 0 so tests exercise the control loop from the first tick
const make = (s = start, bounds = {}) => new RateController(s, bounds, 0);

const HIGH = 4 * 1024 * 1024;

describe("RateController", () => {
  it("ignores backlog during the startup grace period", () => {
    const rc = new RateController(start, {}, 4);
    for (let i = 0; i < 4; i += 1) expect(rc.tick(HIGH).changed).toBe(false);
    expect(rc.tick(HIGH).reason).toBe("congested"); // grace over
  });

  it("stays put while the channel drains", () => {
    const rc = make();
    for (let i = 0; i < 10; i += 1) expect(make().tick(0).reason).not.toBe("congested");
    expect(rc.state.framerate).toBe(30);
  });

  it("backs bitrate off when the backlog spikes", () => {
    const rc = make();
    const d = rc.tick(HIGH + 1);
    expect(d.reason).toBe("congested");
    expect(d.changed).toBe(true);
    expect(rc.state.bitrate).toBeLessThan(8_000_000);
  });

  it("drops framerate only once bitrate is on the floor", () => {
    const rc = make({ bitrate: 1_300_000, framerate: 30 }, { minBitrate: 1_200_000 });
    rc.tick(HIGH + 1); // congested, bitrate to floor
    expect(rc.state.bitrate).toBe(1_200_000);
    rc.tick(HIGH + 1);
    expect(rc.state.framerate).toBe(25);
  });

  it("recovers after a sustained quiet period", () => {
    const rc = make({ bitrate: 2_000_000, framerate: 15 });
    rc.tick(HIGH + 1);
    const lowFps = rc.state.framerate;
    rc.tick(0);
    rc.tick(0);
    const d = rc.tick(0);
    expect(d.reason).toBe("recovering");
    expect(rc.state.framerate).toBeGreaterThan(lowFps);
  });

  it("never oscillates on a steady mid-level backlog", () => {
    const rc = make();
    const seen = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      rc.tick(1 * 1024 * 1024); // between low and high water, not rising
      seen.add(`${rc.state.bitrate}/${rc.state.framerate}`);
    }
    expect(seen.size).toBe(1);
  });

  it("never drops below the 1.2 Mbps floor", () => {
    const rc = make({ bitrate: 2_000_000, framerate: 30 });
    for (let i = 0; i < 30; i += 1) rc.tick(HIGH + 1);
    expect(rc.state.bitrate).toBeGreaterThanOrEqual(1_200_000);
  });
});
