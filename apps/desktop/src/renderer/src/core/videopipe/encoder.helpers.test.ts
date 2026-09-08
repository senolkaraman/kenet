import { describe, expect, it } from "vitest";
import { clampDim } from "./encoder";

describe("clampDim", () => {
  it("keeps normal sizes, forced even", () => {
    expect(clampDim(1366)).toBe(1366);
    expect(clampDim(1367)).toBe(1366);
    expect(clampDim(768)).toBe(768);
  });

  it("never goes below 64 (a few-px window mid-resize)", () => {
    expect(clampDim(3)).toBe(64);
    expect(clampDim(0)).toBe(64);
    expect(clampDim(-10)).toBe(64);
    expect(clampDim(NaN)).toBe(64);
  });
});
