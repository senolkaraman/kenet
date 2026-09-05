import type { OrgMember, OrgSummary, PendingInvite } from "@kenet/protocol";
import { api } from "./api";
import { authStore } from "./auth";
import { Store } from "./store";

const tk = () => authStore.get().token ?? "";

export const orgStore = new Store<{ orgs: OrgSummary[]; invites: PendingInvite[] }>({ orgs: [], invites: [] });

export const refreshOrgs = async (): Promise<void> => {
  if (!tk()) return;
  try {
    const [orgs, invites] = await Promise.all([
      api<{ orgs: OrgSummary[] }>("/orgs", { token: tk() }),
      api<{ invites: PendingInvite[] }>("/invites", { token: tk() })
    ]);
    orgStore.set({ orgs: orgs.orgs, invites: invites.invites });
  } catch {
    /* ignore */
  }
};

export const listMembers = (orgId: string): Promise<{ members: OrgMember[] }> =>
  api(`/orgs/${orgId}/members`, { token: tk() });

export const inviteMember = (orgId: string, email: string, role: "member" | "admin"): Promise<{ ok: boolean }> =>
  api(`/orgs/${orgId}/invites`, { method: "POST", token: tk(), body: { email, role } });

export const removeMember = (orgId: string, userId: string): Promise<{ ok: boolean }> =>
  api(`/orgs/${orgId}/members/${userId}`, { method: "DELETE", token: tk() });

export const acceptInvite = (inviteId: string): Promise<{ ok: boolean }> =>
  api(`/invites/${inviteId}/accept`, { method: "POST", token: tk(), body: {} });
