/**
 * Binary framing for the WebCodecs video path — encoded frames + decoder config + keyframe
 * requests travel over their own RTCDataChannel ("kenet-video"), not JSON, not RTP.
 *
 * Layout (little-endian), first byte is the kind:
 *   kind 1  chunk   : [0]=1 [1]=flags(bit0 key) [2..10]=timestamp µs f64
 *                     [10..14]=duration µs u32 [14..18]=payload len u32 [18..]=payload
 *   kind 2  config  : [0]=2 [1..]=UTF-8 JSON { codec, codedWidth, codedHeight, description? (base64) }
 *   kind 3  key-req : [0]=3           (viewer → host: "I need a keyframe now")
 *   kind 4  hello   : [0]=4 [1..]=UTF-8 JSON { role, wantWidth, wantHeight }  (reserved / future)
 */

export type WireKind = "chunk" | "config" | "keyframe-request" | "hello" | "unknown";

export interface ChunkFrame {
  key: boolean;
  /** microseconds, as produced by EncodedVideoChunk.timestamp */
  timestamp: number;
  /** microseconds; 0 when the encoder did not report one */
  duration: number;
  data: Uint8Array;
}

export interface DecoderConfigMsg {
  codec: string;
  codedWidth: number;
  codedHeight: number;
  /** avcC / codec-private bytes; absent for Annex-B streams */
  description?: Uint8Array;
}

const CHUNK_HEADER = 18;

export const wireKind = (buf: ArrayBuffer | Uint8Array): WireKind => {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (b.byteLength === 0) return "unknown";
  switch (b[0]) {
    case 1:
      return "chunk";
    case 2:
      return "config";
    case 3:
      return "keyframe-request";
    case 4:
      return "hello";
    default:
      return "unknown";
  }
};

export const packChunk = (f: ChunkFrame): ArrayBuffer => {
  const out = new ArrayBuffer(CHUNK_HEADER + f.data.byteLength);
  const view = new DataView(out);
  view.setUint8(0, 1);
  view.setUint8(1, f.key ? 1 : 0);
  view.setFloat64(2, f.timestamp, true);
  view.setUint32(10, Math.max(0, Math.round(f.duration)) >>> 0, true);
  view.setUint32(14, f.data.byteLength, true);
  new Uint8Array(out, CHUNK_HEADER).set(f.data);
  return out;
};

export const unpackChunk = (buf: ArrayBuffer | Uint8Array): ChunkFrame => {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8[0] !== 1 || u8.byteLength < CHUNK_HEADER) throw new Error("not a chunk frame");
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const len = view.getUint32(14, true);
  if (u8.byteLength < CHUNK_HEADER + len) throw new Error("chunk frame truncated");
  return {
    key: (view.getUint8(1) & 1) === 1,
    timestamp: view.getFloat64(2, true),
    duration: view.getUint32(10, true),
    data: u8.subarray(CHUNK_HEADER, CHUNK_HEADER + len)
  };
};

const b64encode = (bytes: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < bytes.byteLength; i += 1) s += String.fromCharCode(bytes[i]!);
  // btoa exists in browsers and in Node 16+ globals
  return typeof btoa === "function" ? btoa(s) : Buffer.from(bytes).toString("base64");
};

const b64decode = (s: string): Uint8Array => {
  if (typeof atob === "function") {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(s, "base64"));
};

export const packConfig = (c: DecoderConfigMsg): ArrayBuffer => {
  const json = JSON.stringify({
    codec: c.codec,
    codedWidth: c.codedWidth,
    codedHeight: c.codedHeight,
    description: c.description ? b64encode(c.description) : undefined
  });
  const body = new TextEncoder().encode(json);
  const out = new Uint8Array(1 + body.byteLength);
  out[0] = 2;
  out.set(body, 1);
  return out.buffer;
};

export const unpackConfig = (buf: ArrayBuffer | Uint8Array): DecoderConfigMsg => {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8[0] !== 2) throw new Error("not a config frame");
  const parsed = JSON.parse(new TextDecoder().decode(u8.subarray(1))) as {
    codec: string;
    codedWidth: number;
    codedHeight: number;
    description?: string;
  };
  return {
    codec: parsed.codec,
    codedWidth: parsed.codedWidth,
    codedHeight: parsed.codedHeight,
    description: parsed.description ? b64decode(parsed.description) : undefined
  };
};

export const packKeyframeRequest = (): ArrayBuffer => new Uint8Array([3]).buffer;
