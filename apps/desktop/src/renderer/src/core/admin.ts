import type { AdminOverview, AdminUser, AdminUserDetail, AdminUserPatch } from "@kenet/protocol";
import { api } from "./api";
import { authStore } from "./auth";

const token = (): string => {
  const t = authStore.get().token;
  if (!t) throw new Error("Giriş yapılmamış.");
  return t;
};

export const fetchOverview = (): Promise<AdminOverview> => api<AdminOverview>("/admin/overview", { token: token() });

export const fetchUsers = (q = ""): Promise<AdminUser[]> =>
  api<AdminUser[]>(`/admin/users?q=${encodeURIComponent(q)}`, { token: token() });

export const fetchUser = (id: string): Promise<AdminUserDetail> =>
  api<AdminUserDetail>(`/admin/users/${id}`, { token: token() });

export const patchUser = (id: string, patch: AdminUserPatch): Promise<AdminUserDetail> =>
  api<AdminUserDetail>(`/admin/users/${id}`, { method: "PATCH", token: token(), body: patch });

export const deleteUser = (id: string): Promise<{ ok: true }> =>
  api<{ ok: true }>(`/admin/users/${id}`, { method: "DELETE", token: token() });
