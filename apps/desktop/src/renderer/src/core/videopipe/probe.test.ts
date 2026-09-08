import { describe, expect, it, vi } from "vitest";
import { selectVideoCodec, CODEC_CANDIDATES, type ProbeFn, type CodecSupport } from "./probe";

const support = (p: Partial<CodecSupport>): CodecSupport => ({ encode: false, decode: false, hardware: false, ...p });

describe("selectVideoCodec", () => {
  it("picks the first hardware-capable codec, in candidate order", async () => {
    const probe: ProbeFn = async (c) =>
      c.codec.startsWith("avc1.4D") // main profile: hw
        ? support({ encode: true, decode: true, hardware: true })
        : support({ encode: true, decode: true, hardware: false });
    const r = await selectVideoCodec(probe, 1366, 768);
    expect(r?.choice.codec).toBe("avc1.4D401F");
    expect(r?.hardware).toBe(true);
  });

  it("returns a software match when no hardware is available and hardware is not required", async () => {
    const probe: ProbeFn = async (c) =>
      c.codec === "vp8" ? support({ encode: true, decode: true, hardware: false }) : support({});
    const r = await selectVideoCodec(probe, 1920, 1080);
    expect(r?.choice.codec).toBe("vp8");
    expect(r?.hardware).toBe(false);
  });

  it("returns null when hardware is required but unavailable", async () => {
    const probe: ProbeFn = async () => support({ encode: true, decode: true, hardware: false });
    const r = await selectVideoCodec(probe, 1920, 1080, { requireHardware: true });
    expect(r).toBeNull();
  });

  it("skips a codec the peer can encode but not decode", async () => {
    const probe: ProbeFn = async (c) =>
      c.codec === "vp09.00.10.08"
        ? support({ encode: true, decode: false, hardware: true })
        : c.codec === "vp8"
          ? support({ encode: true, decode: true, hardware: false })
          : support({});
    const r = await selectVideoCodec(probe, 1280, 720);
    expect(r?.choice.codec).toBe("vp8");
  });

  it("survives a probe that throws for one candidate", async () => {
    const probe: ProbeFn = async (c) => {
      if (c.codec.startsWith("avc1.42")) throw new Error("probe blew up");
      if (c.codec.startsWith("avc1.4D")) return support({ encode: true, decode: true, hardware: true });
      return support({});
    };
    const r = await selectVideoCodec(probe, 1366, 768);
    expect(r?.choice.codec).toBe("avc1.4D401F");
  });

  it("returns null when nothing works at all", async () => {
    const probe: ProbeFn = vi.fn(async () => support({}));
    const r = await selectVideoCodec(probe, 800, 600);
    expect(r).toBeNull();
    expect(probe).toHaveBeenCalledTimes(CODEC_CANDIDATES.length);
  });
});
