import type { DeviceRecord } from "@kenet/protocol";
import { Store } from "./store";
import { api } from "./api";
import { authStore } from "./auth";

export const devicesStore = new Store<{ devices: DeviceRecord[]; loading: boolean }>({
  devices: [],
  loading: false
});
if (import.meta.env.DEV || localStorage.getItem("__rd_debug") === "1") {
  (window as unknown as { kenetDevices?: typeof devicesStore }).kenetDevices = devicesStore;
}

export const refreshDevices = async (): Promise<void> => {
  const token = authStore.get().token;
  if (!token) return;
  devicesStore.set({ loading: true });
  try {
    const result = await api<{ devices: DeviceRecord[] }>("/devices", { token });
    devicesStore.set({ devices: result.devices, loading: false });
  } catch {
    devicesStore.set({ loading: false });
  }
};

export const renameDevice = async (id: string, name: string): Promise<void> => {
  const token = authStore.get().token;
  if (!token) return;
  await api<DeviceRecord>(`/devices/${id}`, { method: "PATCH", token, body: { name } });
  await refreshDevices();
};

export const setUnattended = async (id: string, unattendedPassword: string | null): Promise<void> => {
  const token = authStore.get().token;
  if (!token) return;
  await api<DeviceRecord>(`/devices/${id}`, { method: "PATCH", token, body: { unattendedPassword } });
  await refreshDevices();
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

/** Asks the server to wake an offline device by relaying a magic packet through another
 *  online device on the same network. Returns the relay device's id, or throws with a reason. */
export const wakeDevice = async (id: string): Promise<{ via: string }> => {
  const token = authStore.get().token;
  if (!token) throw new Error("Oturum yok.");
  return api<{ ok: boolean; via: string }>(`/devices/${id}/wake`, { method: "POST", token });
};

export const forgetDevice = async (id: string): Promise<void> => {
  const token = authStore.get().token;
  if (!token) return;
  await api(`/devices/${id}`, { method: "DELETE", token });
  await refreshDevices();
};
