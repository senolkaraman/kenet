import AsyncStorage from "@react-native-async-storage/async-storage";
import type { AuthResponse, AuthUser, LoginResult } from "./protocol";
import { Store } from "./store";
import { api, ApiError } from "./api";

interface AuthState {
  status: "loading" | "signedOut" | "signedIn";
  user: AuthUser | null;
  token: string | null;
}

const KEY = "kenet.auth.v1";

export const authStore = new Store<AuthState>({ status: "loading", user: null, token: null });

const persist = async () => {
  const { token, user } = authStore.get();
  try {
    if (token) await AsyncStorage.setItem(KEY, JSON.stringify({ token, user }));
    else await AsyncStorage.removeItem(KEY);
  } catch {
    /* best effort */
  }
};

/**
 * Restore a saved session on cold start. If a token is stored we sign in *immediately*
 * (optimistically) so the login screen never flashes on a returning user, then validate
 * and renew the token in the background. Only an explicit logout() or a real 401 from
 * the server ever ends the session — a flaky mobile network never does.
 */
export const bootstrapAuth = async (): Promise<void> => {
  let token: string | null = null;
  let user: AuthUser | null = null;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { token?: string; user?: AuthUser };
      token = parsed.token ?? null;
      user = parsed.user ?? null;
    }
  } catch {
    token = null;
  }
  if (!token) {
    authStore.set({ status: "signedOut" });
    return;
  }
  // Trust the stored token up front — the app opens straight to Home.
  authStore.set({ status: "signedIn", token, user });
  try {
    const me = await api<{ user: AuthUser; token: string }>("/auth/me", { token });
    authStore.set({ status: "signedIn", user: me.user, token: me.token });
    await persist();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      // The token is genuinely no longer valid — this is the only automatic sign-out.
      authStore.set({ status: "signedOut", token: null, user: null });
      await persist();
    }
    // Any other error (offline, server hiccup): stay signed in with the stored token.
  }
};

export const refreshMe = async (): Promise<void> => {
  const { token } = authStore.get();
  if (!token) return;
  try {
    const me = await api<{ user: AuthUser; token: string }>("/auth/me", { token });
    authStore.set({ user: me.user, token: me.token });
    await persist();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      authStore.set({ status: "signedOut", token: null, user: null });
      await persist();
    }
    /* otherwise keep current session */
  }
};

const applyAuth = async (res: AuthResponse): Promise<void> => {
  authStore.set({ status: "signedIn", token: res.token, user: res.user });
  await persist();
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

export const register = (email: string, password: string): Promise<void> =>
  api<AuthResponse>("/auth/register", { body: { email, password } }).then(applyAuth);

export const logout = async (): Promise<void> => {
  authStore.set({ status: "signedOut", user: null, token: null });
  await persist();
};
