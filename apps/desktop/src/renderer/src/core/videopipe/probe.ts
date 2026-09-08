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
export const CODEC_CANDIDATES: CodecChoice[] = [
  { codec: "avc1.42E01F", label: "H.264 (Baseline)", avcFormat: "avc" },
  { codec: "avc1.4D401F", label: "H.264 (Main)", avcFormat: "avc" },
  { codec: "vp09.00.10.08", label: "VP9" },
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

  const encCfg: VideoEncoderConfig = {
    codec: choice.codec,
    width,
    height,
    bitrate: 8_000_000,
    framerate: 30,
    latencyMode: "realtime",
    hardwareAcceleration: "prefer-hardware",
    ...(choice.avcFormat === "avc" ? { avc: { format: "avc" } } : {})
  };
  const decCfg: VideoDecoderConfig = {
    codec: choice.codec,
    codedWidth: width,
    codedHeight: height,
    hardwareAcceleration: "prefer-hardware",
    optimizeForLatency: true
  };

  const enc = await VE.isConfigSupported(encCfg);
  const dec = await VD.isConfigSupported(decCfg);

  const hardware = Boolean(enc.supported) && enc.config?.hardwareAcceleration !== "prefer-software";
  return {
    encode: Boolean(enc.supported),
    decode: Boolean(dec.supported),
    hardware
  };
};
