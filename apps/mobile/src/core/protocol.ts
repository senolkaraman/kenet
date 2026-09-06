/**
 * Wire types shared with the Kenet backend + desktop client.
 *
 * This is a hand-kept copy of the subset of `packages/protocol/src/index.ts` that the
 * mobile app uses (types only — no runtime values). It lives here rather than as a
 * workspace import so EAS Build can package `apps/mobile` on its own without the
 * monorepo root. Keep it in sync with the source package when the wire shapes change.
 */

export type Plan = "free" | "pro" | "team";

export interface AuthUser {
  id: string;
  email: string;
  plan: Plan;
  planRenewsAt: string | null;
  orgId: string | null;
  orgRole: "owner" | "admin" | "member" | null;
  totpEnabled: boolean;
  isAdmin: boolean;
}

export interface DeviceRecord {
  id: string;
  name: string;
  online: boolean;
  unattendedEnabled: boolean;
  wakeReady: boolean;
  lastSeenAt: string | null;
  createdAt: string;
}

export interface AuthResponse {
  token: string;
  user: AuthUser;
}

/** Returned by /auth/login instead of AuthResponse when the account has TOTP enabled. */
export interface TotpChallenge {
  requiresTotp: true;
  pendingToken: string;
}

export type LoginResult = AuthResponse | TotpChallenge;

/** Payloads exchanged end-to-end through the signalling relay. */
export type SignalPayload =
  | { type: "connection-request"; requestId: string; requesterName: string; unattended?: string }
  | { type: "connection-decision"; requestId: string; approved: boolean; controlAllowed: boolean; reason?: string }
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string }
  | { type: "ice-candidate"; candidate: string; sdpMid: string | null; sdpMLineIndex: number | null };

/** Messages the client sends over the signalling WebSocket. */
export type ClientMessage =
  | { type: "hello"; token: string; name?: string; mac?: string; subnet?: string }
  | { type: "signal"; to: string; payload: SignalPayload };

/** Messages the server sends back over the signalling WebSocket. */
export type ServerMessage =
  | { type: "ready"; role: "device" | "controller"; sessionId: string; deviceId?: string }
  | { type: "signal"; from: string; fromDevice?: string; payload: SignalPayload }
  | { type: "peer-offline"; to: string }
  | { type: "wake"; mac: string }
  | { type: "error"; code: "UNAUTHORIZED" | "INVALID_MESSAGE" | "PEER_UNAVAILABLE" | "FORBIDDEN"; message: string };
