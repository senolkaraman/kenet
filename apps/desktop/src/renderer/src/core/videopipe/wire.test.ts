import { describe, expect, it } from "vitest";
import {
  packChunk,
  unpackChunk,
  packConfig,
  unpackConfig,
  packKeyframeRequest,
  wireKind
} from "./wire";

describe("videopipe wire", () => {
  it("round-trips a delta chunk", () => {
    const data = new Uint8Array([1, 2, 3, 4, 5, 250, 128, 0]);
    const buf = packChunk({ key: false, timestamp: 123456.5, duration: 33333, data });
    expect(wireKind(buf)).toBe("chunk");
    const back = unpackChunk(buf);
    expect(back.key).toBe(false);
    expect(back.timestamp).toBe(123456.5);
    expect(back.duration).toBe(33333);
    expect([...back.data]).toEqual([...data]);
  });

  it("round-trips a keyframe with a large payload", () => {
    const data = new Uint8Array(200_000).map((_, i) => i % 256);
    const buf = packChunk({ key: true, timestamp: 0, duration: 0, data });
    const back = unpackChunk(buf);
    expect(back.key).toBe(true);
    expect(back.data.byteLength).toBe(200_000);
    expect(back.data[199_999]).toBe(199_999 % 256);
  });

  it("round-trips decoder config with a description", () => {
    const description = new Uint8Array([0x01, 0x64, 0x00, 0x1f, 0xff, 0xe1]);
    const buf = packConfig({ codec: "avc1.640C1F", codedWidth: 1366, codedHeight: 768, description });
    expect(wireKind(buf)).toBe("config");
    const back = unpackConfig(buf);
    expect(back.codec).toBe("avc1.640C1F");
    expect(back.codedWidth).toBe(1366);
    expect(back.codedHeight).toBe(768);
    expect([...(back.description ?? [])]).toEqual([...description]);
  });

  it("round-trips decoder config without a description (Annex-B)", () => {
    const buf = packConfig({ codec: "vp8", codedWidth: 1920, codedHeight: 1080 });
    const back = unpackConfig(buf);
    expect(back.description).toBeUndefined();
    expect(back.codec).toBe("vp8");
  });

  it("tags a keyframe request", () => {
    expect(wireKind(packKeyframeRequest())).toBe("keyframe-request");
  });

  it("does not confuse the kinds", () => {
    expect(wireKind(new Uint8Array([]))).toBe("unknown");
    expect(wireKind(new Uint8Array([9]))).toBe("unknown");
    expect(wireKind(packChunk({ key: false, timestamp: 1, duration: 0, data: new Uint8Array([0]) }))).toBe("chunk");
  });

  it("rejects a truncated chunk", () => {
    const good = new Uint8Array(packChunk({ key: true, timestamp: 1, duration: 0, data: new Uint8Array(50) }));
    expect(() => unpackChunk(good.subarray(0, 30))).toThrow(/truncated/);
  });
});
