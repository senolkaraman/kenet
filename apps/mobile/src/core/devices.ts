import type { DeviceRecord } from "./protocol";
import { Store } from "./store";
import { api } from "./api";
import { authStore } from "./auth";

export const devicesStore = new Store<{ devices: DeviceRecord[]; loading: boolean; error: string | null }>({
  devices: [],
  loading: false,
  error: null
});

export const refreshDevices = async (): Promise<void> => {
  const token = authStore.get().token;
  if (!token) return;
  devicesStore.set({ loading: true, error: null });
  try {
    const result = await api<{ devices: DeviceRecord[] }>("/devices", { token });
    devicesStore.set({ devices: result.devices, loading: false });
  } catch {
    devicesStore.set({ loading: false, error: "Cihaz listesi alınamadı." });
  }
};

export const requestUnattendedTicket = async (id: string, password: string): Promise<string> => {
  const token = authStore.get().token;
  if (!token) throw new Error("Oturum yok.");
  const result = await api<{ ticket: string }>(`/devices/${id}/unattended-ticket`, {
    method: "POST",
    token,
    body: { password }
  });
  return result.ticket;
};
