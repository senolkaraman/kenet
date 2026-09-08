import { CODEC_CANDIDATES, type CodecChoice } from "./probe";

/**
 * Pure: given what the host can hardware-*encode* and what the viewer can hardware-*decode*,
 * pick the video path. The host runs this once it has both capability lists and then tells the
 * viewer the verdict.
 */

export interface VideoCaps {
  /** codec strings from CODEC_CANDIDATES the peer can use, hardware-accelerated */
  hw: string[];
  /** codec strings it can use at all (software) — used only if we ever relax requireHardware */
  sw?: string[];
}

export type VideoDecision =
  | { mode: "webcodecs"; codec: string; choice: CodecChoice; hardware: boolean }
  | { mode: "webrtc"; why: string };

export const decideVideoPath = (
  hostEncode: VideoCaps,
  viewerDecode: VideoCaps,
  opts: { requireHardware?: boolean } = { requireHardware: true }
): VideoDecision => {
  const wantHw = opts.requireHardware !== false;
  const encSet = new Set(hostEncode.hw);
  const decSet = new Set(viewerDecode.hw);

  for (const choice of CODEC_CANDIDATES) {
    if (encSet.has(choice.codec) && decSet.has(choice.codec)) {
      return { mode: "webcodecs", codec: choice.codec, choice, hardware: true };
    }
  }

  if (!wantHw) {
    const encSw = new Set([...(hostEncode.sw ?? []), ...hostEncode.hw]);
    const decSw = new Set([...(viewerDecode.sw ?? []), ...viewerDecode.hw]);
    for (const choice of CODEC_CANDIDATES) {
      if (encSw.has(choice.codec) && decSw.has(choice.codec)) {
        return { mode: "webcodecs", codec: choice.codec, choice, hardware: false };
      }
    }
  }

  const why = !hostEncode.hw.length
    ? "host has no hardware video encoder"
    : !viewerDecode.hw.length
      ? "viewer has no hardware video decoder"
      : "no shared hardware codec";
  return { mode: "webrtc", why };
};
