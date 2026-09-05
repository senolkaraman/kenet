import { query } from "./db.js";
import { HttpError, requireUser, type Ctx } from "./http.js";

const KINDS = new Set(["session-start", "session-end", "unattended-session", "connection-rejected"]);

interface EventRow {
  id: string | number;
  actor_device_id: string | null;
  target_device_id: string | null;
  kind: string;
  at: Date;
}

/** Devices report their own session lifecycle here (device token required). */
export const logEventHandler = async (ctx: Ctx): Promise<{ ok: boolean }> => {
  if (!ctx.claims || ctx.claims.typ !== "device") throw new HttpError(401, "Device token required.");
  const { kind, targetDeviceId } = (ctx.body ?? {}) as { kind?: unknown; targetDeviceId?: unknown };
  if (typeof kind !== "string" || !KINDS.has(kind)) throw new HttpError(400, "Unknown event kind.");

  await query(
    "insert into connection_events (user_id, actor_device_id, target_device_id, kind) values ($1, $2, $3, $4)",
    [ctx.claims.uid, ctx.claims.sub, typeof targetDeviceId === "string" ? targetDeviceId.slice(0, 6) : null, kind]
  );
  return { ok: true };
};

export const listActivityHandler = async (
  ctx: Ctx
): Promise<{ events: Array<{ id: string; actorDeviceId: string | null; targetDeviceId: string | null; kind: string; at: string }> }> => {
  const { userId } = requireUser(ctx);
  const limit = Math.min(100, Math.max(1, Number(ctx.url.searchParams.get("limit") ?? 50)));
  const rows = await query<EventRow>(
    "select id, actor_device_id, target_device_id, kind, at from connection_events where user_id = $1 order by id desc limit $2",
    [userId, limit]
  );
  return {
    events: rows.rows.map((r) => ({
      id: String(r.id),
      actorDeviceId: r.actor_device_id,
      targetDeviceId: r.target_device_id,
      kind: r.kind,
      at: r.at.toISOString()
    }))
  };
};
