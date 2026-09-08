import { describe, expect, it, vi, beforeEach } from "vitest";

// link.ts / encoder.ts use window.setInterval; give them one under the node test env.
vi.stubGlobal("window", {
  setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
  clearInterval: (id: number) => clearInterval(id),
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (id: number) => clearTimeout(id)
});
vi.stubGlobal("performance", globalThis.performance ?? { now: () => Date.now() });

// --- mock the WebCodecs-touching bits so VideoLink's orchestration can be tested in Node ---
const encoderInstances: FakeEncoder[] = [];
const decoderInstances: FakeDecoder[] = [];

class FakeEncoder {
  started = false;
  stopped = false;
  keyframes = 0;
  constructor(public hooks: Record<string, (...a: unknown[]) => void>) {
    encoderInstances.push(this);
  }
  async start(): Promise<void> {
    this.started = true;
  }
  requestKeyframe(): void {
    this.keyframes += 1;
  }
  setRate(): void {}
  stop(): void {
    this.stopped = true;
  }
}
class FakeDecoder {
  started = false;
  stopped = false;
  canvas: unknown;
  constructor(public hooks: Record<string, (...a: unknown[]) => void>) {
    decoderInstances.push(this);
  }
  attach(c: unknown): void {
    this.canvas = c;
  }
  start(): void {
    this.started = true;
  }
  configure(): void {}
  pushChunk(): void {}
  stop(): void {
    this.stopped = true;
  }
}

vi.mock("./encoder", () => ({ ScreenEncoder: FakeEncoder }));
vi.mock("./decoder", () => ({ ScreenDecoder: FakeDecoder }));
vi.mock("./probe", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    probeLocalCaps: vi.fn(async () => ({
      encodeHw: ["avc1.42E01F"],
      decodeHw: ["avc1.42E01F"],
      encodeSw: ["avc1.42E01F", "vp8"],
      decodeSw: ["avc1.42E01F", "vp8"]
    }))
  };
});

const { VideoLink } = await import("./link");

// minimal RTCDataChannel double
class FakeChannel {
  bufferedAmount = 0;
  binaryType = "arraybuffer";
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onopen: (() => void) | null = null;
  sent: unknown[] = [];
  label: string;
  constructor(label: string) {
    this.label = label;
  }
  send(d: unknown): void {
    this.sent.push(d);
  }
  close(): void {}
}

const makePc = () => {
  const channels: FakeChannel[] = [];
  return {
    channels,
    createDataChannel: vi.fn((label: string) => {
      const ch = new FakeChannel(label);
      channels.push(ch);
      queueMicrotask(() => ch.onopen?.());
      return ch as unknown as RTCDataChannel;
    })
  } as unknown as RTCPeerConnection & { channels: FakeChannel[]; createDataChannel: ReturnType<typeof vi.fn> };
};

const track = { getSettings: () => ({ width: 1366, height: 768 }) } as unknown as MediaStreamTrack;

beforeEach(() => {
  encoderInstances.length = 0;
  decoderInstances.length = 0;
});

describe("VideoLink handshake", () => {
  it("negotiates the WebCodecs path and both sides switch mode", async () => {
    const hostPc = makePc();
    const modes: Record<string, string[]> = { host: [], viewer: [] };
    const wires: Record<string, ((m: unknown) => void)[]> = { host: [], viewer: [] };

    const host = new VideoLink({
      role: "host",
      pc: hostPc,
      sendControl: (m) => wires.viewer.forEach((f) => f(m)),
      getScreenTrack: () => track,
      getVideoSender: () => ({ replaceTrack: vi.fn(async () => {}) }) as unknown as RTCRtpSender,
      getCanvas: () => null,
      onMode: (m) => modes.host.push(m),
      onStats: () => {}
    });
    const viewerCanvas = {} as HTMLCanvasElement;
    const viewer = new VideoLink({
      role: "viewer",
      pc: makePc(),
      sendControl: (m) => wires.host.forEach((f) => f(m)),
      getScreenTrack: () => null,
      getVideoSender: () => null,
      getCanvas: () => viewerCanvas,
      onMode: (m) => modes.viewer.push(m),
      onStats: () => {}
    });
    wires.host.push((m) => host.onControlMessage(m));
    wires.viewer.push((m) => viewer.onControlMessage(m));

    await host.start();
    await viewer.start();
    await new Promise((r) => setTimeout(r, 5)); // let microtasks (channel open) run

    expect(modes.host).toContain("webcodecs");
    expect(modes.viewer).toContain("webcodecs");
    expect(hostPc.createDataChannel).toHaveBeenCalledWith("kenet-video", expect.anything());
    expect(encoderInstances[0]?.started).toBe(true);
    expect(decoderInstances[0]?.started).toBe(true);
  });

  it("host falls back to WebRTC when the viewer can't hardware decode", async () => {
    const probe = await import("./probe");
    (probe.probeLocalCaps as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ encodeHw: ["avc1.42E01F"], decodeHw: ["avc1.42E01F"], encodeSw: [], decodeSw: [] }) // host
      .mockResolvedValueOnce({ encodeHw: [], decodeHw: [], encodeSw: ["vp8"], decodeSw: ["vp8"] }); // viewer

    const modes: string[] = [];
    const toViewer: ((m: unknown) => void)[] = [];
    const toHost: ((m: unknown) => void)[] = [];
    const host = new VideoLink({
      role: "host",
      pc: makePc(),
      sendControl: (m) => toViewer.forEach((f) => f(m)),
      getScreenTrack: () => track,
      getVideoSender: () => null,
      getCanvas: () => null,
      onMode: (m, why) => modes.push(`${m}:${why ?? ""}`),
      onStats: () => {}
    });
    const viewer = new VideoLink({
      role: "viewer",
      pc: makePc(),
      sendControl: (m) => toHost.forEach((f) => f(m)),
      getScreenTrack: () => null,
      getVideoSender: () => null,
      getCanvas: () => ({}) as HTMLCanvasElement,
      onMode: () => {},
      onStats: () => {}
    });
    toHost.push((m) => host.onControlMessage(m));
    toViewer.push((m) => viewer.onControlMessage(m));

    await host.start();
    await viewer.start();
    await new Promise((r) => setTimeout(r, 5));

    expect(modes.some((m) => m.startsWith("webrtc:"))).toBe(true);
    expect(encoderInstances.length).toBe(0);
  });
});
