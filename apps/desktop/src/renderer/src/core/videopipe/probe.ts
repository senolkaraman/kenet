/**
 * Decide whether the WebCodecs hardware-encode path can be used, and with which codec.
 *
 * The `select*` function is pure (probe callbacks injected) so the negotiation logic is testable;
 * `probeLocalVideoCodec` is the thin wrapper that actually calls the WebCodecs APIs in the app.
 */

export interface CodecChoice {
  /** e.g. "avc1.42E01F", "vp09.00.10.08", "vp8" */
  codec: string;
  /** human label for the stats panel */
  label: string;
  /** encoder output format — "avc" gives us an avcC description; VP8/VP9 ignore this */
  avcFormat?: "avc" | "annexb";
}

export interface CodecSupport {
  encode: boolean;
  decode: boolean;
  /** true when the probe reported the config as hardware-accelerated (best-effort) */
  hardware: boolean;
}

export type ProbeFn = (choice: CodecChoice, width: number, height: number) => Promise<CodecSupport>;

// Ordered best-first for screen content on Windows: H.264 has the broadest GPU encoder coverage
// (Intel QSV / AMD VCE / NVENC), then VP9, then VP8 as the always-there software fallback.
// Levels are set to 4.0/4.1 (≈2K @ 30fps) — high enough for any laptop panel; a too-low level
// passes isConfigSupported() but makes configure() throw "Encoder creation error".
export const CODEC_CANDIDATES: CodecChoice[] = [
  { codec: "avc1.42E028", label: "H.264 (Baseline)", avcFormat: "avc" },
  { codec: "avc1.4D4028", label: "H.264 (Main)", avcFormat: "avc" },
  { codec: "vp09.00.41.08", label: "VP9" },
  { codec: "vp8", label: "VP8" }
];

export interface SelectResult {
  choice: CodecChoice;
  hardware: boolean;
}

/**
 * Walks the candidate list and returns the first codec both ends can encode AND decode. Prefers a
 * hardware-accelerated match: if `requireHardware` is set and none is hardware, returns null so the
 * caller falls back to the plain WebRTC video path.
 */
export const selectVideoCodec = async (
  probe: ProbeFn,
  width: number,
  height: number,
  opts: { requireHardware?: boolean; candidates?: CodecChoice[] } = {}
): Promise<SelectResult | null> => {
  const candidates = opts.candidates ?? CODEC_CANDIDATES;
  let softwareFallback: SelectResult | null = null;

  for (const choice of candidates) {
    let support: CodecSupport;
    try {
      support = await probe(choice, width, height);
    } catch {
      continue;
    }
    if (!support.encode || !support.decode) continue;
    if (support.hardware) return { choice, hardware: true };
    if (!softwareFallback) softwareFallback = { choice, hardware: false };
  }

  if (opts.requireHardware) return null;
  return softwareFallback;
};

// ---- real WebCodecs probe (browser only) ----

export const probeLocalVideoCodec: ProbeFn = async (choice, width, height) => {
  const VE = (globalThis as typeof globalThis & { VideoEncoder?: typeof VideoEncoder }).VideoEncoder;
  const VD = (globalThis as typeof globalThis & { VideoDecoder?: typeof VideoDecoder }).VideoDecoder;
  if (!VE?.isConfigSupported || !VD?.isConfigSupported) {
    return { encode: false, decode: false, hardware: false };
  }

  const encBase: VideoEncoderConfig = {
    codec: choice.codec,
    width,
    height,
    bitrate: 8_000_000,
    framerate: 30,
    latencyMode: "realtime",
    ...(choice.avcFormat === "avc" ? { avc: { format: "avc" } } : {})
  };
  const decBase: VideoDecoderConfig = {
    codec: choice.codec,
    codedWidth: width,
    codedHeight: height,
    optimizeForLatency: true
  };

  // Older Chromium builds reject the "require-hardware" enum outright (throw, not
  // { supported:false }), so probe each thing independently — one rejection must never take the
  // rest of the answer down with it. "no-preference" is always a valid enum.
  const ok = async (p: Promise<{ supported?: boolean }>): Promise<boolean> => {
    try {
      return Boolean((await p).supported);
    } catch {
      return false;
    }
  };
  const REQUIRE_HW = "require-hardware" as HardwareAcceleration;
  const [encAny, encHw, decAny, decHw] = await Promise.all([
    ok(VE.isConfigSupported({ ...encBase, hardwareAcceleration: "no-preference" })),
    ok(VE.isConfigSupported({ ...encBase, hardwareAcceleration: REQUIRE_HW })),
    ok(VD.isConfigSupported({ ...decBase, hardwareAcceleration: "no-preference" })),
    ok(VD.isConfigSupported({ ...decBase, hardwareAcceleration: REQUIRE_HW }))
  ]);

  return { encode: encAny, decode: decAny, hardware: encHw && decHw };
};

export interface LocalVideoCaps {
  /** codecs this machine can hardware-encode */
  encodeHw: string[];
  /** codecs this machine can hardware-decode */
  decodeHw: string[];
  /** codecs it can encode at all */
  encodeSw: string[];
  decodeSw: string[];
}

/** Probe every candidate once and bucket the results — cheap (isConfigSupported, no real codec). */
export const probeLocalCaps = async (
  width = 1920,
  height = 1080,
  probe: ProbeFn = probeLocalVideoCodec
): Promise<LocalVideoCaps> => {
  const caps: LocalVideoCaps = { encodeHw: [], decodeHw: [], encodeSw: [], decodeSw: [] };
  for (const choice of CODEC_CANDIDATES) {
    let s: CodecSupport;
    try {
      s = await probe(choice, width, height);
    } catch {
      continue;
    }
    if (s.encode) {
      caps.encodeSw.push(choice.codec);
      if (s.hardware) caps.encodeHw.push(choice.codec);
    }
    if (s.decode) {
      caps.decodeSw.push(choice.codec);
      if (s.hardware) caps.decodeHw.push(choice.codec);
    }
  }
  // Safety net: libvpx VP8 software encode+decode ships in every Chromium build. If the probe
  // reported nothing (a broken isConfigSupported, an unrecognised enum, …) but the WebCodecs
  // constructors exist, VP8 is still there — don't let a probe quirk block the whole path.
  const haveApi =
    typeof (globalThis as { VideoEncoder?: unknown }).VideoEncoder === "function" &&
    typeof (globalThis as { VideoDecoder?: unknown }).VideoDecoder === "function";
  if (haveApi && caps.encodeSw.length === 0) caps.encodeSw.push("vp8");
  if (haveApi && caps.decodeSw.length === 0) caps.decodeSw.push("vp8");
  return caps;
};

export const choiceForCodec = (codec: string): CodecChoice | undefined =>
  CODEC_CANDIDATES.find((c) => c.codec === codec);
