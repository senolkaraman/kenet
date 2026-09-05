import type { DeviceRecord, DeviceRegistration } from "@kenet/protocol";
import { query } from "./db.js";
import { hashPassword, verifyPassword } from "./password.js";
import { signDeviceToken, signUnattendedTicket } from "./jwt.js";
import { HttpError, requireUser, type Ctx } from "./http.js";
import { isDeviceOnline, sendWakeRequest, terminateDevice } from "./presence.js";
import { limitsFor, resolvePlan } from "./plans.js";
import { rateLimit } from "./ratelimit.js";

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

const toRecord = (row: DeviceRow): DeviceRecord => ({
  id: row.id,
  name: row.name,
  online: isDeviceOnline(row.id),
  unattendedEnabled: row.unattended_hash != null,
  wakeReady: row.mac_address != null,
  lastSeenAt: row.last_seen_at ? row.last_seen_at.toISOString() : null,
  createdAt: row.created_at.toISOString()
});

const newDeviceId = (): string => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
  let id = "";
  for (let i = 0; i < 6; i += 1) id += alphabet[Math.floor(Math.random() * alphabet.length)];
  return id;
};

export const listDevicesHandler = async (ctx: Ctx): Promise<{ devices: DeviceRecord[] }> => {
  const { userId } = requireUser(ctx);
  const rows = await query<DeviceRow>(
    `select ${DEVICE_COLS} from devices where user_id = $1 order by created_at`,
    [userId]
  );
  return { devices: rows.rows.map(toRecord) };
};

export const registerDeviceHandler = async (ctx: Ctx): Promise<DeviceRegistration> => {
  const { userId } = requireUser(ctx);
  const { name, id } = (ctx.body ?? {}) as { name?: unknown; id?: unknown };
  const deviceName = typeof name === "string" && name.trim() ? name.trim().slice(0, 60) : "Yeni cihaz";

  // Re-registration keeps the same id when the client still has it.
  if (typeof id === "string" && /^[A-Z0-9]{6}$/.test(id)) {
    const owned = await query<DeviceRow>("select id from devices where id = $1 and user_id = $2", [id, userId]);
    if (owned.rowCount) {
      await query("update devices set name = $1 where id = $2", [deviceName, id]);
      const row = (
        await query<DeviceRow>(
          `select ${DEVICE_COLS} from devices where id = $1`,
          [id]
        )
      ).rows[0];
      return { device: toRecord(row), deviceToken: signDeviceToken({ id, userId }) };
    }
  }

  const { plan } = await resolvePlan(userId);
  const count = Number(
    (await query<{ c: string }>("select count(*) as c from devices where user_id = $1", [userId])).rows[0].c
  );
  if (count >= limitsFor(plan).maxDevices) {
    throw new HttpError(
      402,
      `${plan === "free" ? "Ücretsiz plan" : "Planınız"} en fazla ${limitsFor(plan).maxDevices} cihaza izin veriyor. Pro'ya yükseltin.`
    );
  }

  let deviceId = newDeviceId();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const clash = await query("select 1 from devices where id = $1", [deviceId]);
    if (!clash.rowCount) break;
    deviceId = newDeviceId();
  }

  const inserted = await query<DeviceRow>(
    `insert into devices (id, user_id, name) values ($1, $2, $3) returning ${DEVICE_COLS}`,
    [deviceId, userId, deviceName]
  );
  return { device: toRecord(inserted.rows[0]), deviceToken: signDeviceToken({ id: deviceId, userId }) };
};

export const patchDeviceHandler = async (ctx: Ctx): Promise<DeviceRecord> => {
  const { userId } = requireUser(ctx);
  const deviceId = ctx.params.id;
  const { name, unattendedPassword } = (ctx.body ?? {}) as { name?: unknown; unattendedPassword?: unknown };

  const owned = await query<DeviceRow>("select id from devices where id = $1 and user_id = $2", [deviceId, userId]);
  if (!owned.rowCount) throw new HttpError(404, "Cihaz bulunamadı.");

  if (typeof name === "string" && name.trim()) {
    await query("update devices set name = $1 where id = $2", [name.trim().slice(0, 60), deviceId]);
  }
  if (unattendedPassword === null) {
    await query("update devices set unattended_hash = null where id = $1", [deviceId]);
  } else if (typeof unattendedPassword === "string" && unattendedPassword.length >= 6) {
    const { plan } = await resolvePlan(userId);
    if (!limitsFor(plan).unattendedAccess) {
      throw new HttpError(402, "Gözetimsiz erişim Pro ve Ekip planlarında kullanılabilir.");
    }
    await query("update devices set unattended_hash = $1 where id = $2", [await hashPassword(unattendedPassword), deviceId]);
  }

  const row = (
    await query<DeviceRow>(
      `select ${DEVICE_COLS} from devices where id = $1`,
      [deviceId]
    )
  ).rows[0];
  return toRecord(row);
};

export const unattendedTicketHandler = async (ctx: Ctx): Promise<{ ticket: string }> => {
  // No ownership check by design: the whole point of an unattended password is that
  // someone other than the device's account owner can use it to connect. The password
  // itself, plus a tight per-IP rate limit, is the access control here.
  if (!rateLimit(`unattended:${ctx.ip}`, 8, 5 * 60 * 1000)) {
    throw new HttpError(429, "Çok fazla deneme. Birkaç dakika sonra tekrar deneyin.");
  }
  const { userId } = requireUser(ctx);
  const { password } = (ctx.body ?? {}) as { password?: unknown };
  if (typeof password !== "string" || !password) throw new HttpError(400, "Şifre gerekli.");

  const row = (
    await query<DeviceRow>("select id, unattended_hash from devices where id = $1", [ctx.params.id])
  ).rows[0];
  if (!row || !row.unattended_hash) throw new HttpError(404, "Bu cihazda gözetimsiz erişim kapalı.");

  const ok = await verifyPassword(password, row.unattended_hash);
  if (!ok) throw new HttpError(401, "Gözetimsiz erişim şifresi hatalı.");

  return { ticket: signUnattendedTicket(row.id, userId) };
};

export const rotateDeviceHandler = async (ctx: Ctx): Promise<DeviceRegistration> => {
  const { userId } = requireUser(ctx);
  const oldId = ctx.params.id;
  const owned = await query<DeviceRow>("select id from devices where id = $1 and user_id = $2", [oldId, userId]);
  if (!owned.rowCount) throw new HttpError(404, "Cihaz bulunamadı.");

  let newId = newDeviceId();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const clash = await query("select 1 from devices where id = $1", [newId]);
    if (!clash.rowCount) break;
    newId = newDeviceId();
  }

  const updated = await query<DeviceRow>(
    `update devices set id = $1 where id = $2 returning ${DEVICE_COLS}`,
    [newId, oldId]
  );
  // Kick the old, now-invalid connection (if it's live) so a stale link doesn't linger
  // and the app is forced to reconnect under its new identity.
  terminateDevice(oldId);

  return { device: toRecord(updated.rows[0]), deviceToken: signDeviceToken({ id: newId, userId }) };
};

export const wakeDeviceHandler = async (ctx: Ctx): Promise<{ ok: boolean; via: string }> => {
  const { userId } = requireUser(ctx);
  if (!rateLimit(`wake:${userId}`, 10, 60_000)) {
    throw new HttpError(429, "Çok fazla uyandırma isteği. Birazdan tekrar deneyin.");
  }
  const row = (
    await query<DeviceRow>(`select ${DEVICE_COLS} from devices where id = $1 and user_id = $2`, [ctx.params.id, userId])
  ).rows[0];
  if (!row) throw new HttpError(404, "Cihaz bulunamadı.");
  if (isDeviceOnline(row.id)) throw new HttpError(409, "Bu cihaz zaten çevrimiçi.");
  if (!row.mac_address || !row.last_subnet) {
    throw new HttpError(400, "Bu cihazın ağ bilgisi yok — en az bir kez bağlanması gerekiyor.");
  }

  const via = sendWakeRequest(userId, row.last_subnet, row.id, row.mac_address);
  if (!via) {
    throw new HttpError(
      409,
      "Aynı ağda çevrimiçi başka bir cihazın yok. Uyandırma paketini gönderebilecek bir aracı bulunamadı."
    );
  }
  return { ok: true, via };
};

export const deleteDeviceHandler = async (ctx: Ctx): Promise<{ deleted: boolean }> => {
  const { userId } = requireUser(ctx);
  const result = await query("delete from devices where id = $1 and user_id = $2", [ctx.params.id, userId]);
  if (!result.rowCount) throw new HttpError(404, "Cihaz bulunamadı.");
  return { deleted: true };
};
