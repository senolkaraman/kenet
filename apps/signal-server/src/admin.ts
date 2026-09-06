import type {
  AdminOverview,
  AdminUser,
  AdminUserDetail,
  AdminUserPatch,
  DeviceRecord,
  Plan
} from "@kenet/protocol";
import { query } from "./db.js";
import { env } from "./env.js";
import { HttpError, requireUser, type Ctx } from "./http.js";
import { isDeviceOnline, terminateDevice } from "./presence.js";

/** Like requireUser, but 403s unless the account is an operator. */
const requireAdmin = async (ctx: Ctx): Promise<{ userId: string; email: string }> => {
  const u = requireUser(ctx);
  if (env.adminEmails.includes(u.email.toLowerCase())) return u;
  const row = (await query<{ is_admin: boolean }>("select is_admin from users where id = $1", [u.userId])).rows[0];
  if (!row?.is_admin) throw new HttpError(403, "Yönetici erişimi gerekli.");
  return u;
};

const SESSION_KINDS = ["session-start", "unattended-session"];
const since7d = () => new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
const num = (v: unknown) => Number(v ?? 0);

interface UserRow {
  id: string;
  email: string;
  plan: string;
  is_admin: boolean;
  disabled: boolean;
  device_limit_override: number | null;
  notes: string | null;
  created_at: Date;
}

/** device count + 7-day session count + last activity for a set of user ids, keyed by id. */
const aggregatesFor = async (
  ids: string[]
): Promise<Map<string, { devices: number; sessions7d: number; lastAt: string | null }>> => {
  const out = new Map<string, { devices: number; sessions7d: number; lastAt: string | null }>();
  ids.forEach((id) => out.set(id, { devices: 0, sessions7d: 0, lastAt: null }));
  if (!ids.length) return out;

  const dev = await query<{ user_id: string; c: string }>(
    "select user_id, count(*) as c from devices where user_id = any($1) group by user_id",
    [ids]
  );
  dev.rows.forEach((r) => (out.get(r.user_id)!.devices = num(r.c)));

  const sess = await query<{ user_id: string; c: string }>(
    "select user_id, count(*) as c from connection_events where user_id = any($1) and kind = any($2) and at > $3 group by user_id",
    [ids, SESSION_KINDS, since7d()]
  );
  sess.rows.forEach((r) => {
    const e = out.get(r.user_id);
    if (e) e.sessions7d = num(r.c);
  });

  const last = await query<{ user_id: string; m: Date | null }>(
    "select user_id, max(at) as m from connection_events where user_id = any($1) group by user_id",
    [ids]
  );
  last.rows.forEach((r) => {
    const e = out.get(r.user_id);
    if (e) e.lastAt = r.m ? new Date(r.m).toISOString() : null;
  });

  return out;
};

const toAdminUser = (
  r: UserRow,
  agg: { devices: number; sessions7d: number; lastAt: string | null }
): AdminUser => ({
  id: r.id,
  email: r.email,
  plan: (r.plan as Plan) ?? "free",
  isAdmin: r.is_admin,
  disabled: r.disabled,
  deviceLimitOverride: r.device_limit_override,
  deviceCount: agg.devices,
  sessions7d: agg.sessions7d,
  lastActivityAt: agg.lastAt,
  createdAt: new Date(r.created_at).toISOString()
});

export const adminOverviewHandler = async (ctx: Ctx): Promise<AdminOverview> => {
  await requireAdmin(ctx);
  const cutoff = since7d();
  const users = (await query<UserRow>("select id, is_admin, disabled, created_at from users")).rows;
  const active = (
    await query<{ n: string }>("select count(distinct user_id) as n from connection_events where at > $1", [cutoff])
  ).rows[0];
  const sessions = (
    await query<{ n: string }>("select count(*) as n from connection_events where kind = any($1) and at > $2", [
      SESSION_KINDS,
      cutoff
    ])
  ).rows[0];
  const dev = (await query<{ id: string }>("select id from devices")).rows;

  return {
    users: users.length,
    admins: users.filter((u) => u.is_admin).length,
    disabled: users.filter((u) => u.disabled).length,
    newUsers7d: users.filter((u) => new Date(u.created_at).toISOString() > cutoff).length,
    activeUsers7d: num(active.n),
    devices: dev.length,
    devicesOnline: dev.filter((d) => isDeviceOnline(d.id)).length,
    sessions7d: num(sessions.n)
  };
};

export const adminUsersHandler = async (ctx: Ctx): Promise<AdminUser[]> => {
  await requireAdmin(ctx);
  const q = (ctx.url.searchParams.get("q") ?? "").trim().toLowerCase();
  const limit = Math.min(200, Math.max(1, Number(ctx.url.searchParams.get("limit") ?? 100)));
  const offset = Math.max(0, Number(ctx.url.searchParams.get("offset") ?? 0));

  const rows = (
    await query<UserRow>(
      `select id, email, plan, is_admin, disabled, device_limit_override, notes, created_at
         from users
        where ($1 = '' or lower(email) like '%' || $1 || '%')
        order by created_at desc
        limit $2 offset $3`,
      [q, limit, offset]
    )
  ).rows;
  const agg = await aggregatesFor(rows.map((r) => r.id));
  return rows.map((r) => toAdminUser(r, agg.get(r.id)!));
};

const DEVICE_COLS = "id, name, unattended_hash, mac_address, last_subnet, last_seen_at, created_at";
interface DeviceRow {
  id: string;
  name: string;
  unattended_hash: string | null;
  mac_address: string | null;
  last_subnet: string | null;
  last_seen_at: Date | null;
  created_at: Date;
}
const toDeviceRecord = (row: DeviceRow): DeviceRecord => ({
  id: row.id,
  name: row.name,
  online: isDeviceOnline(row.id),
  unattendedEnabled: row.unattended_hash != null,
  wakeReady: row.mac_address != null,
  lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null,
  createdAt: new Date(row.created_at).toISOString()
});

export const adminUserDetailHandler = async (ctx: Ctx): Promise<AdminUserDetail> => {
  await requireAdmin(ctx);
  const id = ctx.params.id;
  const row = (
    await query<UserRow>(
      "select id, email, plan, is_admin, disabled, device_limit_override, notes, created_at from users where id = $1",
      [id]
    )
  ).rows[0];
  if (!row) throw new HttpError(404, "Kullanıcı bulunamadı.");

  const agg = (await aggregatesFor([id])).get(id)!;
  const devices = (
    await query<DeviceRow>(`select ${DEVICE_COLS} from devices where user_id = $1 order by created_at`, [id])
  ).rows.map(toDeviceRecord);

  const events = (
    await query<{ kind: string; at: Date; actor_device_id: string | null; target_device_id: string | null }>(
      "select kind, at, actor_device_id, target_device_id from connection_events where user_id = $1 order by id desc limit 50",
      [id]
    )
  ).rows.map((e) => ({
    kind: e.kind,
    at: new Date(e.at).toISOString(),
    actorDeviceId: e.actor_device_id,
    targetDeviceId: e.target_device_id
  }));

  return { ...toAdminUser(row, agg), notes: row.notes, devices, recentEvents: events };
};

const PLANS: Plan[] = ["free", "pro", "team"];

export const adminPatchUserHandler = async (ctx: Ctx): Promise<AdminUserDetail> => {
  const me = await requireAdmin(ctx);
  const id = ctx.params.id;
  const patch = (ctx.body ?? {}) as AdminUserPatch;

  const target = (await query<{ email: string }>("select email from users where id = $1", [id])).rows[0];
  if (!target) throw new HttpError(404, "Kullanıcı bulunamadı.");

  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (col: string, val: unknown) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };

  if (patch.plan !== undefined) {
    if (!PLANS.includes(patch.plan)) throw new HttpError(400, "Geçersiz plan.");
    push("plan", patch.plan);
    push("subscription_status", patch.plan === "free" ? null : "active");
  }
  if (patch.isAdmin !== undefined) {
    if (id === me.userId && patch.isAdmin === false) throw new HttpError(400, "Kendi yönetici erişimini kaldıramazsın.");
    if (env.adminEmails.includes(target.email.toLowerCase()) && patch.isAdmin === false) {
      throw new HttpError(400, "Bu hesap sunucu ayarında yönetici olarak tanımlı.");
    }
    push("is_admin", patch.isAdmin);
  }
  if (patch.disabled !== undefined) {
    if (id === me.userId && patch.disabled) throw new HttpError(400, "Kendi hesabını devre dışı bırakamazsın.");
    push("disabled", patch.disabled);
  }
  if (patch.deviceLimitOverride !== undefined) {
    const v = patch.deviceLimitOverride;
    if (v !== null && (!Number.isInteger(v) || v < 0 || v > 10000)) throw new HttpError(400, "Geçersiz cihaz limiti.");
    push("device_limit_override", v);
  }
  if (patch.notes !== undefined) push("notes", String(patch.notes).slice(0, 2000));

  if (sets.length) {
    params.push(id);
    await query(`update users set ${sets.join(", ")} where id = $${params.length}`, params);
  }

  if (patch.disabled) {
    const devs = (await query<{ id: string }>("select id from devices where user_id = $1", [id])).rows;
    for (const d of devs) terminateDevice(d.id);
  }

  return adminUserDetailHandler(ctx);
};

export const adminDeleteUserHandler = async (ctx: Ctx): Promise<{ ok: true }> => {
  const me = await requireAdmin(ctx);
  const id = ctx.params.id;
  if (id === me.userId) throw new HttpError(400, "Kendi hesabını silemezsin.");
  const target = (await query<{ email: string }>("select email from users where id = $1", [id])).rows[0];
  if (!target) throw new HttpError(404, "Kullanıcı bulunamadı.");
  if (env.adminEmails.includes(target.email.toLowerCase())) {
    throw new HttpError(400, "Sunucu ayarındaki yönetici hesabı silinemez.");
  }
  const devs = (await query<{ id: string }>("select id from devices where user_id = $1", [id])).rows;
  for (const d of devs) terminateDevice(d.id);
  await query("delete from users where id = $1", [id]); // cascades to devices / events / orgs
  return { ok: true };
};
