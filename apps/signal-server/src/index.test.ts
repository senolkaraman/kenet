import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { DataType, newDb } from "pg-mem";

process.env.JWT_SECRET = "test-secret";

const { setPool, migrate } = await import("./db.js");
const mem = newDb();
mem.public.registerFunction({
  name: "gen_random_uuid",
  returns: DataType.uuid,
  impure: true,
  implementation: () => randomUUID()
});
const pg = mem.adapters.createPg();
setPool(new pg.Pool());

const {
  registerHandler,
  loginHandler,
  forgotHandler,
  resetHandler,
  meHandler,
  totpSetupHandler,
  totpEnableHandler,
  totpDisableHandler,
  totpVerifyHandler
} = await import("./auth.js");
const { currentTotpCode } = await import("./totp.js");
const {
  registerDeviceHandler,
  listDevicesHandler,
  patchDeviceHandler,
  deleteDeviceHandler,
  unattendedTicketHandler,
  rotateDeviceHandler
} = await import("./devices.js");
const { logEventHandler, listActivityHandler } = await import("./activity.js");
const { inviteHandler, pendingInvitesHandler, acceptInviteHandler, listMembersHandler, sharesOrg } = await import(
  "./orgs.js"
);
const { verifyToken } = await import("./jwt.js");
const { query } = await import("./db.js");

const grantPro = (userId: string) =>
  query("update users set plan = 'pro', subscription_status = 'active', plan_renews_at = now() + interval '1 month' where id = $1", [userId]);

let ipCounter = 0;
const ctx = (body: unknown, token?: string) => ({
  req: {} as never,
  res: {} as never,
  url: new URL("http://x/"),
  params: {} as Record<string, string>,
  body,
  claims: token ? verifyToken(token) : null,
  ip: `test-${ipCounter++}` // unique per call so the rate limiter never trips in tests
});

beforeAll(async () => {
  await migrate();
});

describe("account + device lifecycle", () => {
  let token = "";
  let deviceId = "";

  it("registers a user", async () => {
    const res = await registerHandler(ctx({ email: "a@b.com", password: "supersecret" }));
    expect(res.user.email).toBe("a@b.com");
    expect(res.user.plan).toBe("free");
    expect(res.token.split(".")).toHaveLength(3);
    token = res.token;
    await grantPro(res.user.id);
  });

  it("rejects duplicate email", async () => {
    await expect(registerHandler(ctx({ email: "a@b.com", password: "supersecret" }))).rejects.toThrow();
  });

  it("logs in with correct password", async () => {
    const res = await loginHandler(ctx({ email: "a@b.com", password: "supersecret" }));
    if ("requiresTotp" in res) throw new Error("unexpected TOTP challenge");
    expect(res.user.id).toBeTruthy();
  });

  it("/auth/me renews the session token every time (sliding session, no re-login needed)", async () => {
    const me = await meHandler(ctx({}, token));
    expect(me.token.split(".")).toHaveLength(3);
    const claims = verifyToken(me.token);
    expect(claims?.typ).toBe("user");
    expect(claims && "sub" in claims ? claims.sub : null).toBe(me.user.id);
    // The renewed token works just as well as the original for a follow-up call.
    const again = await meHandler(ctx({}, me.token));
    expect(again.user.email).toBe(me.user.email);
  });

  it("rejects wrong password", async () => {
    await expect(loginHandler(ctx({ email: "a@b.com", password: "wrongpass1" }))).rejects.toThrow();
  });

  it("registers a device and issues a device token", async () => {
    const res = await registerDeviceHandler(ctx({ name: "Ofis-PC" }, token));
    expect(res.device.id).toMatch(/^[A-Z0-9]{6}$/);
    expect(res.device.name).toBe("Ofis-PC");
    const claims = verifyToken(res.deviceToken);
    expect(claims?.typ).toBe("device");
    deviceId = res.device.id;
  });

  it("lists the user's devices", async () => {
    const res = await listDevicesHandler(ctx({}, token));
    expect(res.devices.map((d) => d.id)).toContain(deviceId);
  });

  it("renames a device", async () => {
    const c = ctx({ name: "Salon-PC" }, token);
    c.params.id = deviceId;
    const res = await patchDeviceHandler(c);
    expect(res.name).toBe("Salon-PC");
  });

  it("rotates a device's code, keeping its history but issuing a fresh id + token", async () => {
    const c = ctx({}, token);
    c.params.id = deviceId;
    const rotated = await rotateDeviceHandler(c);
    expect(rotated.device.id).not.toBe(deviceId);
    expect(rotated.device.name).toBe("Salon-PC");
    const claims = verifyToken(rotated.deviceToken);
    expect(claims?.typ).toBe("device");
    expect(claims && "sub" in claims ? claims.sub : null).toBe(rotated.device.id);

    // the old id is gone from this account's list; only the new one remains
    const list = await listDevicesHandler(ctx({}, token));
    expect(list.devices.map((d) => d.id)).toContain(rotated.device.id);
    expect(list.devices.map((d) => d.id)).not.toContain(deviceId);

    deviceId = rotated.device.id; // subsequent tests in this block use the rotated id
  });

  it("sets an unattended password", async () => {
    const c = ctx({ unattendedPassword: "let-me-in" }, token);
    c.params.id = deviceId;
    const res = await patchDeviceHandler(c);
    expect(res.unattendedEnabled).toBe(true);
  });

  it("rejects an unattended password shorter than 8 characters", async () => {
    const c = ctx({ unattendedPassword: "short" }, token);
    c.params.id = deviceId;
    await expect(patchDeviceHandler(c)).rejects.toThrow(/8 karakter/);
  });

  it("issues an unattended ticket for the correct password and rejects a wrong one", async () => {
    const good = ctx({ password: "let-me-in" }, token);
    good.params.id = deviceId;
    const res = await unattendedTicketHandler(good);
    const claims = verifyToken(res.ticket);
    expect(claims?.typ).toBe("unattended");
    expect(claims?.sub).toBe(deviceId);

    const bad = ctx({ password: "wrong-pass" }, token);
    bad.params.id = deviceId;
    await expect(unattendedTicketHandler(bad)).rejects.toThrow();
  });

  it("blocks device access from another account", async () => {
    const other = await registerHandler(ctx({ email: "c@d.com", password: "supersecret" }));
    const c = ctx({ name: "hijack" }, other.token);
    c.params.id = deviceId;
    await expect(deleteDeviceHandler(c)).rejects.toThrow();
  });

  it("enforces the free-plan device limit and blocks unattended", async () => {
    const free = await registerHandler(ctx({ email: "free@b.com", password: "supersecret" }));
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push((await registerDeviceHandler(ctx({ name: `d${i}` }, free.token))).device.id);
    await expect(registerDeviceHandler(ctx({ name: "d6" }, free.token))).rejects.toThrow(/Pro/);

    const c = ctx({ unattendedPassword: "nope-free" }, free.token);
    c.params.id = ids[0];
    await expect(patchDeviceHandler(c)).rejects.toThrow(/Pro/);
  });

  it("records and lists connection activity", async () => {
    const account = await registerHandler(ctx({ email: "act@b.com", password: "supersecret" }));
    const dev = await registerDeviceHandler(ctx({ name: "actor" }, account.token));
    await logEventHandler(ctx({ kind: "session-start", targetDeviceId: "TARGET" }, dev.deviceToken));
    await logEventHandler(ctx({ kind: "session-end" }, dev.deviceToken));
    await expect(logEventHandler(ctx({ kind: "bogus" }, dev.deviceToken))).rejects.toThrow();

    const list = await listActivityHandler(ctx({}, account.token));
    expect(list.events).toHaveLength(2);
    expect(list.events[0].kind).toBe("session-end"); // newest first (id desc)
    expect(list.events[1].targetDeviceId).toBe("TARGET");
  });

  it("rejects activity writes without a device token", async () => {
    const account = await registerHandler(ctx({ email: "act2@b.com", password: "supersecret" }));
    await expect(logEventHandler(ctx({ kind: "session-start" }, account.token))).rejects.toThrow();
  });
});

describe("password reset", () => {
  it("resets the password via a logged token", async () => {
    await registerHandler(ctx({ email: "reset@b.com", password: "originalpass" }));

    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    await forgotHandler(ctx({ email: "reset@b.com" }));
    await forgotHandler(ctx({ email: "nobody@nowhere.com" })); // no leak, no throw
    console.log = original;

    const line = logs.find((l) => l.includes("[password-reset] reset@b.com"));
    expect(line).toBeTruthy();
    const token = line!.split("token ")[1].trim();

    const res = await resetHandler(ctx({ token, password: "brand-new-pass" }));
    expect(res.user.email).toBe("reset@b.com");

    await expect(loginHandler(ctx({ email: "reset@b.com", password: "originalpass" }))).rejects.toThrow();
    const ok = await loginHandler(ctx({ email: "reset@b.com", password: "brand-new-pass" }));
    if ("requiresTotp" in ok) throw new Error("unexpected TOTP challenge");
    expect(ok.token.split(".")).toHaveLength(3);

    await expect(resetHandler(ctx({ token, password: "reuse-attempt" }))).rejects.toThrow(); // one-shot
  });
});

describe("teams / organisations", () => {
  it("invites a member, lets them accept, and grants shared access", async () => {
    const owner = await registerHandler(ctx({ email: "boss@team.com", password: "supersecret" }));
    const mate = await registerHandler(ctx({ email: "mate@team.com", password: "supersecret" }));

    const org = (
      await query<{ id: string }>(
        "insert into organizations (name, owner_user_id, seats, subscription_status) values ($1, $2, 5, 'active') returning id",
        ["Acme", owner.user.id]
      )
    ).rows[0];
    await query("insert into org_members (org_id, user_id, role) values ($1, $2, 'owner')", [org.id, owner.user.id]);

    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => logs.push(a.join(" "));
    const inv = ctx({ email: "mate@team.com", role: "member" }, owner.token);
    inv.params.id = org.id;
    await inviteHandler(inv);
    console.log = orig;

    const pending = await pendingInvitesHandler(ctx({}, mate.token));
    expect(pending.invites).toHaveLength(1);

    const accept = ctx({}, mate.token);
    accept.params.id = pending.invites[0].id;
    await acceptInviteHandler(accept);

    const membersCtx = ctx({}, owner.token);
    membersCtx.params.id = org.id;
    const members = await listMembersHandler(membersCtx);
    expect(members.members.map((m) => m.email).sort()).toEqual(["boss@team.com", "mate@team.com"]);

    expect(await sharesOrg(owner.user.id, mate.user.id)).toBe(true);

    const mateMe = await import("./auth.js").then((m) => m.buildUser(mate.user.id, "mate@team.com"));
    expect(mateMe.plan).toBe("team");
  });

  it("stops invites once seats are full", async () => {
    const owner = await registerHandler(ctx({ email: "small@team.com", password: "supersecret" }));
    const org = (
      await query<{ id: string }>(
        "insert into organizations (name, owner_user_id, seats) values ($1, $2, 1) returning id",
        ["Solo", owner.user.id]
      )
    ).rows[0];
    await query("insert into org_members (org_id, user_id, role) values ($1, $2, 'owner')", [org.id, owner.user.id]);
    const inv = ctx({ email: "x@team.com" }, owner.token);
    inv.params.id = org.id;
    await expect(inviteHandler(inv)).rejects.toThrow(/oltuk/);
  });
});

describe("TOTP two-factor auth", () => {
  it("enrolls, then requires a code to finish logging in, and lets a recovery code substitute once", async () => {
    const reg = await registerHandler(ctx({ email: "totp@b.com", password: "supersecret" }));
    const token = reg.token;

    // Setup issues a secret; a wrong code can't turn it on yet.
    const setup = await totpSetupHandler(ctx({}, token));
    expect(setup.secret).toMatch(/^[A-Z2-7]+$/);
    await expect(totpEnableHandler(ctx({ code: "000000" }, token))).rejects.toThrow(/hatalı/);

    // The right code (computed the same way a real authenticator app would) enables it.
    const enabled = await totpEnableHandler(ctx({ code: currentTotpCode(setup.secret) }, token));
    expect(enabled.recoveryCodes).toHaveLength(8);

    // Password alone now only gets a pending challenge, not a session.
    const attempt = await loginHandler(ctx({ email: "totp@b.com", password: "supersecret" }));
    if (!("requiresTotp" in attempt)) throw new Error("expected a TOTP challenge");

    // A wrong 6-digit code (and a bogus recovery code) are rejected.
    await expect(
      totpVerifyHandler(ctx({ pendingToken: attempt.pendingToken, code: "111111" }))
    ).rejects.toThrow(/hatalı/);

    // The real recovery code finishes login...
    const viaRecovery = await totpVerifyHandler(
      ctx({ pendingToken: attempt.pendingToken, code: enabled.recoveryCodes[0] })
    );
    expect(viaRecovery.user.email).toBe("totp@b.com");

    // ...and is now one-time-spent: the same login attempt's recovery code can't be reused.
    const attempt2 = await loginHandler(ctx({ email: "totp@b.com", password: "supersecret" }));
    if (!("requiresTotp" in attempt2)) throw new Error("expected a TOTP challenge");
    await expect(
      totpVerifyHandler(ctx({ pendingToken: attempt2.pendingToken, code: enabled.recoveryCodes[0] }))
    ).rejects.toThrow(/hatalı/);

    // But a fresh app code still works.
    const viaApp = await totpVerifyHandler(
      ctx({ pendingToken: attempt2.pendingToken, code: currentTotpCode(setup.secret) })
    );
    expect(viaApp.user.totpEnabled).toBe(true);

    // Disabling requires the account password, not just a bearer token.
    await expect(totpDisableHandler(ctx({ password: "wrong-pass" }, token))).rejects.toThrow(/hatalı/);
    const off = await totpDisableHandler(ctx({ password: "supersecret" }, token));
    expect(off.ok).toBe(true);
    const plainLogin = await loginHandler(ctx({ email: "totp@b.com", password: "supersecret" }));
    if ("requiresTotp" in plainLogin) throw new Error("TOTP should be off now");
    expect(plainLogin.user.totpEnabled).toBe(false);
  });
});

describe("rate limiting", () => {
  it("blocks repeated logins from one ip", async () => {
    const { rateLimit } = await import("./ratelimit.js");
    let allowed = 0;
    for (let i = 0; i < 15; i += 1) if (rateLimit("login:1.2.3.4", 10, 60_000)) allowed += 1;
    expect(allowed).toBe(10);
  });

  it("exempts admin/allowlisted callers", async () => {
    const { rateLimit } = await import("./ratelimit.js");
    let allowed = 0;
    for (let i = 0; i < 15; i += 1) if (rateLimit("connreq:admin", 5, 60_000, true)) allowed += 1;
    expect(allowed).toBe(15);
  });

  it("keys on the infra-appended tail of X-Forwarded-For, not the client-supplied front", async () => {
    const { clientIp } = await import("./ratelimit.js");
    // Client forges "1.1.1.1"; Cloud Run appends the real "9.9.9.9". depth=1 must return the real one.
    expect(clientIp({ "x-forwarded-for": "1.1.1.1, 9.9.9.9" }, "sock", 1)).toBe("9.9.9.9");
    expect(clientIp({ "x-forwarded-for": "1.1.1.1, 9.9.9.9, 10.0.0.1" }, "sock", 2)).toBe("9.9.9.9");
    // depth=0 ignores the header entirely.
    expect(clientIp({ "x-forwarded-for": "1.1.1.1" }, "sock", 0)).toBe("sock");
    // No header → socket address.
    expect(clientIp({}, "sock", 1)).toBe("sock");
  });
});

describe("admin panel", () => {
  let adminToken = "";
  let victimId = "";
  let victimToken = "";
  let bossId = "";

  it("promotes a user to admin and lists everyone", async () => {
    const adminMod = await import("./admin.js");
    const a = await registerHandler(ctx({ email: "boss@b.com", password: "supersecret" }));
    adminToken = a.token;
    bossId = a.user.id;
    const v = await registerHandler(ctx({ email: "victim@b.com", password: "supersecret" }));
    victimId = v.user.id;
    victimToken = v.token;

    await expect(adminMod.adminUsersHandler(ctx({}, victimToken))).rejects.toThrow(/[Yy]önetici/);

    await query("update users set is_admin = true where id = $1", [bossId]);

    const list = await adminMod.adminUsersHandler(ctx({}, adminToken));
    expect(list.find((u) => u.email === "victim@b.com")).toBeTruthy();

    const ov = await adminMod.adminOverviewHandler(ctx({}, adminToken));
    expect(ov.users).toBeGreaterThanOrEqual(2);
    expect(ov.admins).toBeGreaterThanOrEqual(1);
  });

  it("sets a device-limit override and enforces it", async () => {
    const adminMod = await import("./admin.js");
    const c = ctx({ deviceLimitOverride: 1 }, adminToken);
    c.params.id = victimId;
    const patched = await adminMod.adminPatchUserHandler(c);
    expect(patched.deviceLimitOverride).toBe(1);

    await registerDeviceHandler(ctx({ name: "pc1" }, victimToken));
    await expect(registerDeviceHandler(ctx({ name: "pc2" }, victimToken))).rejects.toThrow();
  });

  it("disables an account so it can no longer log in", async () => {
    const adminMod = await import("./admin.js");
    const c = ctx({ disabled: true }, adminToken);
    c.params.id = victimId;
    await adminMod.adminPatchUserHandler(c);
    await expect(loginHandler(ctx({ email: "victim@b.com", password: "supersecret" }))).rejects.toThrow(/devre dışı/);
  });

  it("won't let an admin disable or demote themselves", async () => {
    const adminMod = await import("./admin.js");
    const c1 = ctx({ disabled: true }, adminToken);
    c1.params.id = bossId;
    await expect(adminMod.adminPatchUserHandler(c1)).rejects.toThrow();
    const c2 = ctx({ isAdmin: false }, adminToken);
    c2.params.id = bossId;
    await expect(adminMod.adminPatchUserHandler(c2)).rejects.toThrow();
  });
});
