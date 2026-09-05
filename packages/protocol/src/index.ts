export type ClientPlatform = "desktop" | "web";

export interface PeerIdentity {
  id: string;
  platform: ClientPlatform;
  name: string;
}

/** Subscription plans. A user is "pro" via a personal subscription or via team membership. */
export type Plan = "free" | "pro" | "team";

export interface PlanLimits {
  maxDevices: number;
  unattendedAccess: boolean;
  sessionRecording: boolean;
  concurrentSessions: number;
  teamMembers: number;
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: { maxDevices: 5, unattendedAccess: false, sessionRecording: false, concurrentSessions: 1, teamMembers: 1 },
  pro: {
    maxDevices: Number.MAX_SAFE_INTEGER,
    unattendedAccess: true,
    sessionRecording: true,
    concurrentSessions: 3,
    teamMembers: 1
  },
  team: {
    maxDevices: Number.MAX_SAFE_INTEGER,
    unattendedAccess: true,
    sessionRecording: true,
    concurrentSessions: 10,
    teamMembers: 50
  }
};

/** Account + device REST shapes. */
export interface AuthUser {
  id: string;
  email: string;
  plan: Plan;
  planRenewsAt: string | null;
  orgId: string | null;
  orgRole: "owner" | "admin" | "member" | null;
  totpEnabled: boolean;
}

export interface DeviceRecord {
  id: string;
  name: string;
  online: boolean;
  unattendedEnabled: boolean;
  /** True once we've learned this device's MAC (it connected at least once) — a Wake-on-LAN
   *  request can be attempted for it, relayed through another online device on its network. */
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

export interface TotpSetup {
  secret: string;
  otpauthUrl: string;
}

export interface TotpEnableResult {
  recoveryCodes: string[];
}

export interface OrgMember {
  userId: string;
  email: string;
  role: "owner" | "admin" | "member";
  joinedAt: string;
}

export interface OrgSummary {
  id: string;
  name: string;
  role: "owner" | "admin" | "member";
  seats: number;
  memberCount: number;
  subscriptionStatus: string | null;
}

export interface PendingInvite {
  id: string;
  orgId: string;
  orgName: string;
  role: "admin" | "member";
}

export interface DeviceRegistration {
  device: DeviceRecord;
  deviceToken: string;
}

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
  // "You're the closest online device to one the user wants to wake — send a magic packet."
  | { type: "wake"; mac: string }
  | { type: "error"; code: "UNAUTHORIZED" | "INVALID_MESSAGE" | "PEER_UNAVAILABLE" | "FORBIDDEN"; message: string };
