import { api } from "./api";
import { authStore } from "./auth";

export interface ActivityEvent {
  id: string;
  actorDeviceId: string | null;
  targetDeviceId: string | null;
  kind: string;
  at: string;
}

export const fetchActivity = async (): Promise<ActivityEvent[]> => {
  const token = authStore.get().token;
  if (!token) return [];
  try {
    const result = await api<{ events: ActivityEvent[] }>("/activity?limit=60", { token });
    return result.events;
  } catch {
    return [];
  }
};

export const activityLabel = (kind: string): string =>
  ({
    "session-start": "Oturum başladı",
    "session-end": "Oturum bitti",
    "unattended-session": "Gözetimsiz oturum",
    "connection-rejected": "Bağlantı reddedildi"
  })[kind] ?? kind;
