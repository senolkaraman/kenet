import { describe, expect, it } from "vitest";
import { decideVideoPath } from "./negotiate";

describe("decideVideoPath", () => {
  it("picks the best shared hardware codec in candidate order", () => {
    const d = decideVideoPath(
      { hw: ["vp8", "avc1.4D4028", "avc1.42E028"] },
      { hw: ["avc1.42E028", "vp8"] }
    );
    expect(d.mode).toBe("webcodecs");
    if (d.mode === "webcodecs") expect(d.codec).toBe("avc1.42E028"); // first in CODEC_CANDIDATES both have
  });

  it("falls back to WebRTC when the host has no hardware encoder", () => {
    const d = decideVideoPath({ hw: [] }, { hw: ["avc1.42E028"] });
    expect(d).toEqual({ mode: "webrtc", why: "host has no hardware video encoder" });
  });

  it("falls back to WebRTC when the viewer can't hardware decode", () => {
    const d = decideVideoPath({ hw: ["avc1.42E028"] }, { hw: [] });
    expect(d).toEqual({ mode: "webrtc", why: "viewer has no hardware video decoder" });
  });

  it("falls back to WebRTC when there is no overlap", () => {
    const d = decideVideoPath({ hw: ["avc1.42E028"] }, { hw: ["vp09.00.10.08"] });
    expect(d).toEqual({ mode: "webrtc", why: "no shared hardware codec" });
  });

  it("can use a software codec when hardware is not required", () => {
    const d = decideVideoPath(
      { hw: [], sw: ["vp8"] },
      { hw: [], sw: ["vp8"] },
      { requireHardware: false }
    );
    expect(d.mode).toBe("webcodecs");
    if (d.mode === "webcodecs") expect(d.codec).toBe("vp8");
  });

  it("prefers VP8 over H.264 on the software path (fastest to encode)", () => {
    const d = decideVideoPath(
      { hw: [], sw: ["avc1.42E028", "vp09.00.41.08", "vp8"] },
      { hw: [], sw: ["avc1.42E028", "vp09.00.41.08", "vp8"] },
      { requireHardware: false }
    );
    if (d.mode === "webcodecs") {
      expect(d.codec).toBe("vp8");
      expect(d.hardware).toBe(false);
    }
  });

  it("still prefers a hardware match over software when hardware not required", () => {
    const d = decideVideoPath(
      { hw: ["avc1.42E028"], sw: ["vp8"] },
      { hw: ["avc1.42E028"], sw: ["vp8"] },
      { requireHardware: false }
    );
    if (d.mode === "webcodecs") expect(d.codec).toBe("avc1.42E028");
  });
});
