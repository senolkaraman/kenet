import { Store } from "./store";

export type ThemeMode = "dark" | "light";
export type QualityMode = "auto" | "sharp" | "smooth";

export interface Settings {
  serverUrl: string;
  deviceName: string;
  theme: ThemeMode;
  quality: QualityMode;
  autoFullscreen: boolean;
  askBeforeControl: boolean;
  startWithWindows: boolean;
  runInBackground: boolean;
  /** Keep both sides' clipboards in sync automatically during a session. */
  clipboardSync: boolean;
  /** Auto-end an unattended session after this many idle minutes (0 = never). */
  unattendedIdleTimeoutMin: number;
  /** Device ids whose connection requests are auto-approved (with control), no dialog. */
  trustedDevices: string[];
}

const KEY = "kenet.settings.v3";

const defaultServerUrl =
  import.meta.env.VITE_SERVER_URL ??
  (import.meta.env.DEV ? "ws://localhost:8787" : "wss://remotedesk-signal-v2-4bcbwtjl6q-uc.a.run.app");

const migrateLegacy = (): Partial<Settings> => {
  const out: Partial<Settings> = {};
  try {
    const v2 = JSON.parse(localStorage.getItem("remotedesk.settings.v2") ?? "{}") as { signalUrl?: string; deviceName?: string };
    if (v2.signalUrl) out.serverUrl = v2.signalUrl;
    if (v2.deviceName) out.deviceName = v2.deviceName;
  } catch {
    /* ignore */
  }
  const legacyUrl = localStorage.getItem("remotedesk.signalUrl");
  const legacyName = localStorage.getItem("remotedesk.deviceName");
  if (legacyUrl) out.serverUrl = legacyUrl;
  if (legacyName) out.deviceName = legacyName;
  return out;
};

const load = (): Settings => {
  const base: Settings = {
    serverUrl: defaultServerUrl,
    deviceName: "",
    theme: "dark",
    quality: "auto",
    autoFullscreen: false,
    askBeforeControl: true,
    startWithWindows: false,
    runInBackground: true,
    clipboardSync: true,
    unattendedIdleTimeoutMin: 20,
    trustedDevices: []
  };
  let stored: Partial<Settings> = {};
  try {
    stored = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Settings>;
  } catch {
    stored = {};
  }
  return { ...base, ...migrateLegacy(), ...stored };
};

export const settingsStore = new Store<Settings>(load());

export const updateSettings = (patch: Partial<Settings>): void => {
  settingsStore.set(patch);
  localStorage.setItem(KEY, JSON.stringify(settingsStore.get()));
  applyTheme(settingsStore.get().theme);
};

export const applyTheme = (theme: ThemeMode): void => {
  document.documentElement.dataset.theme = theme;
};

if (!settingsStore.get().deviceName) {
  const host = (globalThis as { process?: { env?: Record<string, string> } }).process?.env?.COMPUTERNAME;
  updateSettings({ deviceName: host || "Windows PC" });
}
applyTheme(settingsStore.get().theme);
