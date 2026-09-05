import AsyncStorage from "@react-native-async-storage/async-storage";
import { Store } from "./store";

/** The deployed Kenet signalling + API server (Cloud Run). Same backend the desktop app uses. */
export const DEFAULT_SERVER_URL = "wss://remotedesk-signal-v2-4bcbwtjl6q-uc.a.run.app";

const SERVER_KEY = "kenet.serverUrl";

export const configStore = new Store<{ serverUrl: string }>({ serverUrl: DEFAULT_SERVER_URL });

export async function loadConfig(): Promise<void> {
  try {
    const stored = await AsyncStorage.getItem(SERVER_KEY);
    if (stored) configStore.set({ serverUrl: stored });
  } catch {
    /* keep default */
  }
}

export async function setServerUrl(url: string): Promise<void> {
  const trimmed = url.trim().replace(/\/$/, "");
  configStore.set({ serverUrl: trimmed || DEFAULT_SERVER_URL });
  try {
    await AsyncStorage.setItem(SERVER_KEY, configStore.get().serverUrl);
  } catch {
    /* best effort */
  }
}

export const httpBase = (): string =>
  configStore.get().serverUrl.replace(/^ws:/, "http:").replace(/^wss:/, "https:").replace(/\/$/, "");

export const wsUrl = (): string =>
  `${configStore.get().serverUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:").replace(/\/$/, "")}/ws`;
