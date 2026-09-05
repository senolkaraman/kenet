import { createHash, randomBytes } from "node:crypto";
import type { OrgMember, OrgSummary, PendingInvite } from "@kenet/protocol";
import { query } from "./db.js";
import { HttpError, requireUser, type Ctx } from "./http.js";
import { sendInviteEmail } from "./email.js";

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface MemberRow {
  role: string;
}

const requireOrgRole = async (
  orgId: string,
  userId: string,
  roles: string[]
): Promise<void> => {
  const row = (await query<MemberRow>("select role from org_members where org_id = $1 and user_id = $2", [orgId, userId]))
    .rows[0];
  if (!row || !roles.includes(row.role)) throw new HttpError(403, "Bu işlem için yetkin yok.");
};

export const listOrgsHandler = async (ctx: Ctx): Promise<{ orgs: OrgSummary[] }> => {
  const { userId } = requireUser(ctx);
  const rows = await query<{
    id: string;
    name: string;
    role: string;
    seats: number;
    subscription_status: string | null;
    member_count: string;
  }>(
    `select o.id, o.name, m.role, o.seats, o.subscription_status,
            (select count(*) from org_members where org_id = o.id) as member_count
       from org_members m join organizations o on o.id = m.org_id
      where m.user_id = $1`,
    [userId]
  );
  return {
    orgs: rows.rows.map((r) => ({
      id: r.id,
      name: r.name,
      role: r.role as OrgSummary["role"],
      seats: r.seats,
      memberCount: Number(r.member_count),
      subscriptionStatus: r.subscription_status
    }))
  };
};

export const listMembersHandler = async (ctx: Ctx): Promise<{ members: OrgMember[] }> => {
  const { userId } = requireUser(ctx);
  await requireOrgRole(ctx.params.id, userId, ["owner", "admin", "member"]);
  const rows = await query<{ user_id: string; email: string; role: string; joined_at: Date }>(
    `select m.user_id, u.email, m.role, m.joined_at
       from org_members m join users u on u.id = m.user_id
      where m.org_id = $1 order by m.joined_at`,
    [ctx.params.id]
  );
  return {
    members: rows.rows.map((r) => ({
      userId: r.user_id,
      email: r.email,
      role: r.role as OrgMember["role"],
      joinedAt: r.joined_at.toISOString()
    }))
  };
};

export const inviteHandler = async (ctx: Ctx): Promise<{ ok: true }> => {
  const { userId } = requireUser(ctx);
  const orgId = ctx.params.id;
  await requireOrgRole(orgId, userId, ["owner", "admin"]);

  const { email, role } = (ctx.body ?? {}) as { email?: unknown; role?: unknown };
  if (typeof email !== "string" || !EMAIL_RE.test(email.trim())) throw new HttpError(400, "Geçerli bir e-posta girin.");
  const memberRole = role === "admin" ? "admin" : "member";
  const target = email.trim().toLowerCase();

  const org = (await query<{ seats: number; name: string }>("select seats, name from organizations where id = $1", [orgId]))
    .rows[0];
  const used = Number(
    (await query<{ c: string }>("select count(*) as c from org_members where org_id = $1", [orgId])).rows[0].c
  );
  const pending = Number(
    (
      await query<{ c: string }>("select count(*) as c from org_invites where org_id = $1 and expires_at > now()", [orgId])
    ).rows[0].c
  );
  if (used + pending >= org.seats) throw new HttpError(409, "Koltuk sayısı doldu. Aboneliği yükseltin.");

  const token = randomBytes(24).toString("hex");
  await query("delete from org_invites where org_id = $1 and email = $2", [orgId, target]);
  await query(
    "insert into org_invites (org_id, email, role, token_hash, expires_at) values ($1, $2, $3, $4, now() + interval '7 days')",
    [orgId, target, memberRole, sha256(token)]
  );
  await sendInviteEmail(target, org.name, token);
  return { ok: true };
};

export const pendingInvitesHandler = async (ctx: Ctx): Promise<{ invites: PendingInvite[] }> => {
  const { email } = requireUser(ctx);
  const rows = await query<{ id: string; org_id: string; org_name: string; role: string }>(
    `select i.id, i.org_id, o.name as org_name, i.role
       from org_invites i join organizations o on o.id = i.org_id
      where i.email = $1 and i.expires_at > now()`,
    [email.toLowerCase()]
  );
  return {
    invites: rows.rows.map((r) => ({
      id: r.id,
      orgId: r.org_id,
      orgName: r.org_name,
      role: r.role as PendingInvite["role"]
    }))
  };
};

export const acceptInviteHandler = async (ctx: Ctx): Promise<{ ok: true }> => {
  const { userId, email } = requireUser(ctx);
  const invite = (
    await query<{ org_id: string; role: string; email: string; expires_at: Date }>(
      "select org_id, role, email, expires_at from org_invites where id = $1",
      [ctx.params.id]
    )
  ).rows[0];
  if (!invite || invite.expires_at.getTime() < Date.now() || invite.email !== email.toLowerCase()) {
    throw new HttpError(404, "Davet bulunamadı ya da süresi dolmuş.");
  }
  await query(
    "insert into org_members (org_id, user_id, role) values ($1, $2, $3) on conflict do nothing",
    [invite.org_id, userId, invite.role]
  );
  await query("delete from org_invites where id = $1", [ctx.params.id]);
  return { ok: true };
};

export const removeMemberHandler = async (ctx: Ctx): Promise<{ ok: true }> => {
  const { userId } = requireUser(ctx);
  const { id: orgId, userId: targetUserId } = ctx.params;
  await requireOrgRole(orgId, userId, ["owner", "admin"]);
  const owner = (await query<{ owner_user_id: string }>("select owner_user_id from organizations where id = $1", [orgId]))
    .rows[0];
  if (owner?.owner_user_id === targetUserId) throw new HttpError(400, "Sahip ekipten çıkarılamaz.");
  await query("delete from org_members where org_id = $1 and user_id = $2", [orgId, targetUserId]);
  await query("update devices set org_id = null where org_id = $1 and user_id = $2", [orgId, targetUserId]);
  return { ok: true };
};

/** Are these two users in the same organisation? Used by the signalling relay. */
export const sharesOrg = async (userA: string, userB: string): Promise<boolean> => {
  if (userA === userB) return true;
  const row = await query(
    `select 1 from org_members a join org_members b on a.org_id = b.org_id
      where a.user_id = $1 and b.user_id = $2 limit 1`,
    [userA, userB]
  );
  return (row.rowCount ?? 0) > 0;
};
