export interface LinkStats {
  rttMs: number | null;
  fps: number | null;
  kbps: number | null;
  width: number | null;
  height: number | null;
  transport: "direct" | "relay" | "unknown";
  packetLoss: number | null;
  /** Host side: why the encoder is degrading, if it is — "cpu" | "bandwidth" | "other". */
  limited?: string | null;
}

export const emptyStats: LinkStats = {
  rttMs: null,
  fps: null,
  kbps: null,
  width: null,
  height: null,
  transport: "unknown",
  packetLoss: null,
  limited: null
};

/** Polls RTCPeerConnection.getStats and derives a human-readable link summary. */
export class StatsProbe {
  private timer: number | undefined;
  private lastBytes = 0;
  private lastTs = 0;
  private lastLost = 0;
  private lastPackets = 0;

  constructor(
    private readonly pc: RTCPeerConnection,
    private readonly onUpdate: (stats: LinkStats) => void,
    private readonly intervalMs = 1000
  ) {}

  start(): void {
    this.stop();
    this.timer = window.setInterval(() => void this.sample(), this.intervalMs);
    void this.sample();
  }

  stop(): void {
    if (this.timer !== undefined) window.clearInterval(this.timer);
    this.timer = undefined;
  }

  private async sample(): Promise<void> {
    let report: RTCStatsReport;
    try {
      report = await this.pc.getStats();
    } catch {
      return;
    }
    const next: LinkStats = { ...emptyStats };
    const candidatePairs = new Map<string, RTCIceCandidatePairStats>();
    const candidates = new Map<string, { candidateType?: string }>();

    report.forEach((entry) => {
      if (entry.type === "inbound-rtp" && (entry as RTCInboundRtpStreamStats).kind === "video") {
        const rtp = entry as RTCInboundRtpStreamStats & {
          bytesReceived?: number;
          timestamp: number;
          framesPerSecond?: number;
          frameWidth?: number;
          frameHeight?: number;
          packetsLost?: number;
          packetsReceived?: number;
        };
        if (rtp.bytesReceived != null && this.lastTs) {
          const dt = (rtp.timestamp - this.lastTs) / 1000;
          if (dt > 0) next.kbps = Math.max(0, Math.round(((rtp.bytesReceived - this.lastBytes) * 8) / 1000 / dt));
        }
        this.lastBytes = rtp.bytesReceived ?? this.lastBytes;
        this.lastTs = rtp.timestamp;
        next.fps = rtp.framesPerSecond != null ? Math.round(rtp.framesPerSecond) : next.fps;
        next.width = rtp.frameWidth ?? next.width;
        next.height = rtp.frameHeight ?? next.height;
        if (rtp.packetsLost != null && rtp.packetsReceived != null) {
          const dLost = rtp.packetsLost - this.lastLost;
          const dRecv = rtp.packetsReceived - this.lastPackets;
          if (dRecv > 0) next.packetLoss = Math.max(0, Math.min(100, Math.round((dLost / (dLost + dRecv)) * 1000) / 10));
          this.lastLost = rtp.packetsLost;
          this.lastPackets = rtp.packetsReceived;
        }
      }
      // Host side has no inbound video — read the send stats instead so "Gönderim" / fps / resolution
      // actually reflect what the encoder is doing (and surface when it's falling behind).
      if (entry.type === "outbound-rtp" && (entry as RTCOutboundRtpStreamStats).kind === "video") {
        const rtp = entry as RTCOutboundRtpStreamStats & {
          bytesSent?: number;
          timestamp: number;
          framesPerSecond?: number;
          frameWidth?: number;
          frameHeight?: number;
          qualityLimitationReason?: string;
        };
        if (rtp.bytesSent != null && this.lastTs) {
          const dt = (rtp.timestamp - this.lastTs) / 1000;
          if (dt > 0) next.kbps = Math.max(0, Math.round(((rtp.bytesSent - this.lastBytes) * 8) / 1000 / dt));
        }
        this.lastBytes = rtp.bytesSent ?? this.lastBytes;
        this.lastTs = rtp.timestamp;
        if (rtp.framesPerSecond != null) next.fps = Math.round(rtp.framesPerSecond);
        next.width = rtp.frameWidth ?? next.width;
        next.height = rtp.frameHeight ?? next.height;
        next.limited = rtp.qualityLimitationReason && rtp.qualityLimitationReason !== "none"
          ? rtp.qualityLimitationReason
          : null;
      }
      // Sender side: the receiver's RTCP feedback — this is how the host learns the viewer is
      // dropping its packets (which is what makes GCC crater the bitrate).
      if (entry.type === "remote-inbound-rtp" && (entry as { kind?: string }).kind === "video") {
        const r = entry as { fractionLost?: number; roundTripTime?: number };
        if (r.fractionLost != null) next.packetLoss = Math.round(r.fractionLost * 1000) / 10;
        if (r.roundTripTime != null && next.rttMs == null) next.rttMs = Math.round(r.roundTripTime * 1000);
      }
      if (entry.type === "candidate-pair") candidatePairs.set(entry.id, entry as RTCIceCandidatePairStats);
      if (entry.type === "local-candidate" || entry.type === "remote-candidate") {
        candidates.set(entry.id, entry as { candidateType?: string });
      }
    });

    let active: RTCIceCandidatePairStats | undefined;
    candidatePairs.forEach((pair) => {
      const p = pair as RTCIceCandidatePairStats & { state?: string; nominated?: boolean; selected?: boolean };
      if (p.selected || p.nominated || p.state === "succeeded") {
        if (!active || (p.state === "succeeded" && !active.state)) active = pair;
      }
    });
    if (active) {
      const rtt = (active as RTCIceCandidatePairStats & { currentRoundTripTime?: number }).currentRoundTripTime;
      if (rtt != null) next.rttMs = Math.round(rtt * 1000);
      const local = candidates.get((active as { localCandidateId?: string }).localCandidateId ?? "");
      const remote = candidates.get((active as { remoteCandidateId?: string }).remoteCandidateId ?? "");
      const relayed = local?.candidateType === "relay" || remote?.candidateType === "relay";
      next.transport = relayed ? "relay" : "direct";
    }

    this.onUpdate(next);
  }
}

export const linkGrade = (s: LinkStats): "ok" | "warn" | "bad" => {
  if (s.rttMs == null && s.fps == null) return "warn";
  if ((s.rttMs ?? 0) > 220 || (s.packetLoss ?? 0) > 4 || (s.fps ?? 60) < 8) return "bad";
  if ((s.rttMs ?? 0) > 110 || (s.packetLoss ?? 0) > 1.2 || (s.fps ?? 60) < 18) return "warn";
  return "ok";
};
