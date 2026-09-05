import type {
  AuthResponse,
  AuthUser,
  DeviceRecord,
  DeviceRegistration,
  LoginResult,
  TotpEnableResult,
  TotpSetup
} from "@kenet/protocol";
import { Store } from "./store";
import { api, ApiError } from "./api";
import { settingsStore } from "./settings";

interface AuthState {
  status: "loading" | "signedOut" | "signedIn";
  user: AuthUser | null;
  token: string | null;
  device: DeviceRecord | null;
  deviceToken: string | null;
  deviceError: string | null;
}

const KEY = "kenet.auth.v1";

const load = (): Pick<AuthState, "token" | "device" | "deviceToken"> => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<AuthState>;
    return { token: raw.token ?? null, device: raw.device ?? null, deviceToken: raw.deviceToken ?? null };
  } catch {
    return { token: null, device: null, deviceToken: null };
  }
};

export const authStore = new Store<AuthState>({
  status: "loading",
  user: null,
  deviceError: null,
  ...load()
});
// Internal state hook — off for real users; enable with localStorage.__rd_debug = "1" (used by E2E tests).
if (import.meta.env.DEV || localStorage.getItem("__rd_debug") === "1") {
  (window as unknown as { kenetAuth?: typeof authStore }).kenetAuth = authStore;
}

const persist = () => {
  const { token, device, deviceToken } = authStore.get();
  localStorage.setItem(KEY, JSON.stringify({ token, device, deviceToken }));
};

export const authHeader = () => authStore.get().token ?? undefined;

export const ensureDevice = async (): Promise<void> => {
  const { token, device } = authStore.get();
  if (!token) return;
  try {
    const result = await api<DeviceRegistration>("/devices", {
      method: "POST",
      token,
      body: { name: settingsStore.get().deviceName, id: device?.id }
    });
    authStore.set({ device: result.device, deviceToken: result.deviceToken, deviceError: null });
    persist();
  } catch (error) {
    // Most commonly the plan's device limit — surface it instead of failing silently
    // (without a deviceToken the app never opens the signalling socket, so it just
    // sits at "offline" with no explanation).
    const message = error instanceof ApiError ? error.message : "Bu cihaz kaydedilemedi.";
    authStore.set({ deviceError: message });
    console.error("Device registration failed:", message);
  }
};

/**
 * Retires this device's current code and issues a brand-new one — same device, same
 * settings, fresh identity. Useful if a code got shared too widely, or if a connection
 * ever gets stuck (a new code forces both sides to start clean).
 */
export const rotateThisDevice = async (): Promise<void> => {
  const { token, device } = authStore.get();
  if (!token || !device) return;
  const result = await api<DeviceRegistration>(`/devices/${device.id}/rotate`, { method: "POST", token });
  authStore.set({ device: result.device, deviceToken: result.deviceToken, deviceError: null });
  persist();
};

export const bootstrapAuth = async (): Promise<void> => {
  const { token } = authStore.get();
  if (!token) {
    authStore.set({ status: "signedOut" });
    return;
  }
  try {
    const me = await api<{ user: AuthUser; token: string }>("/auth/me", { token });
    authStore.set({ status: "signedIn", user: me.user, token: me.token });
    persist();
    await ensureDevice();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      authStore.set({ status: "signedOut", token: null, user: null });
      persist();
    } else {
      // Server unreachable — keep the stored session, allow retry.
      authStore.set({ status: "signedOut" });
    }
  }
};

const applyAuth = async (res: AuthResponse): Promise<void> => {
  authStore.set({ status: "signedIn", token: res.token, user: res.user });
  persist();
  await ensureDevice();
};

/** Re-fetch the current user (plan, org) — also silently renews the session token (see meHandler). */
export const refreshMe = async (): Promise<void> => {
  const { token } = authStore.get();
  if (!token) return;
  try {
    const me = await api<{ user: AuthUser; token: string }>("/auth/me", { token });
    authStore.set({ user: me.user, token: me.token });
    persist();
  } catch {
    /* keep current */
  }
};

/** Returns a pending-2FA token when the account has TOTP enabled; otherwise logs straight in. */
export const login = async (email: string, password: string): Promise<{ pendingToken: string } | null> => {
  const res = await api<LoginResult>("/auth/login", { body: { email, password } });
  if ("requiresTotp" in res) return { pendingToken: res.pendingToken };
  await applyAuth(res);
  return null;
};

export const verifyTotp = (pendingToken: string, code: string): Promise<void> =>
  api<AuthResponse>("/auth/totp/verify", { body: { pendingToken, code } }).then(applyAuth);

const requireToken = (): string => {
  const { token } = authStore.get();
  if (!token) throw new ApiError(401, "Giriş yapılmamış.");
  return token;
};

/** Starts (or restarts) TOTP enrollment — issues a fresh secret, not yet enabled. */
export const setupTotp = (): Promise<TotpSetup> =>
  api<TotpSetup>("/auth/totp/setup", { method: "POST", token: requireToken() });

/** Confirms enrollment with one real app code; returns one-time recovery codes to show once. */
export const enableTotp = async (code: string): Promise<TotpEnableResult> => {
  const result = await api<TotpEnableResult>("/auth/totp/enable", { method: "POST", token: requireToken(), body: { code } });
  await refreshMe();
  return result;
};

/** Turns TOTP back off — the server re-checks the account password as a safety net. */
export const disableTotp = async (password: string): Promise<void> => {
  await api("/auth/totp/disable", { method: "POST", token: requireToken(), body: { password } });
  await refreshMe();
};

export const register = (email: string, password: string): Promise<void> =>
  api<AuthResponse>("/auth/register", { body: { email, password } }).then(applyAuth);

export const forgotPassword = (email: string): Promise<{ ok: boolean }> =>
  api<{ ok: boolean }>("/auth/forgot", { body: { email } });

export const resetPassword = (token: string, password: string): Promise<void> =>
  api<AuthResponse>("/auth/reset", { body: { token, password } }).then(applyAuth);

export const logout = (): void => {
  authStore.set({ status: "signedOut", user: null, token: null, device: null, deviceToken: null });
  localStorage.removeItem(KEY);
};
