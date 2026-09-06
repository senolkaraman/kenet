import { useEffect, useState } from "react";
import type { AdminOverview, AdminUser, AdminUserDetail, Plan } from "@kenet/protocol";
import { deleteUser, fetchOverview, fetchUser, fetchUsers, patchUser } from "../core/admin";
import { Modal } from "../components/Modal";
import { Icon } from "../components/Icon";
import { Button } from "../components/primitives";

const fmtDate = (s: string | null) =>
  s ? new Date(s).toLocaleString("tr-TR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";

export function AdminModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<"overview" | "users">("overview");
  const [ov, setOv] = useState<AdminOverview | null>(null);
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void fetchOverview().then(setOv).catch((e) => setErr(String(e.message ?? e)));
  }, []);

  const loadUsers = () => {
    setUsers(null);
    void fetchUsers(q).then(setUsers).catch((e) => setErr(String(e.message ?? e)));
  };
  useEffect(() => {
    if (tab === "users" && users === null) loadUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  return (
    <Modal title="Yönetici paneli" icon={<Icon name="shield" />} onClose={onClose}>
      <div className="admin-tabs">
        <button className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}>
          Genel bakış
        </button>
        <button className={tab === "users" ? "active" : ""} onClick={() => setTab("users")}>
          Kullanıcılar
        </button>
      </div>

      {err && <p className="error small">{err}</p>}

      {tab === "overview" && (
        <div className="admin-stats">
          {ov === null ? (
            <span className="spinner" />
          ) : (
            [
              ["Toplam kullanıcı", ov.users],
              ["Son 7 gün yeni", ov.newUsers7d],
              ["Son 7 gün aktif", ov.activeUsers7d],
              ["Yöneticiler", ov.admins],
              ["Devre dışı", ov.disabled],
              ["Toplam cihaz", ov.devices],
              ["Çevrimiçi cihaz", ov.devicesOnline],
              ["Son 7 gün oturum", ov.sessions7d]
            ].map(([label, value]) => (
              <div className="admin-stat" key={label}>
                <strong>{value}</strong>
                <span>{label}</span>
              </div>
            ))
          )}
        </div>
      )}

      {tab === "users" && (
        <div className="admin-users">
          <form
            className="admin-search"
            onSubmit={(e) => {
              e.preventDefault();
              loadUsers();
            }}
          >
            <input placeholder="E-posta ara…" value={q} onChange={(e) => setQ(e.target.value)} />
            <Button size="sm" variant="subtle" type="submit">
              Ara
            </Button>
          </form>
          <div className="admin-list">
            {users === null && <span className="spinner" />}
            {users?.length === 0 && <p className="muted center small">Kayıt yok.</p>}
            {users?.map((u) => (
              <button key={u.id} className="admin-row" onClick={() => setSelected(u.id)}>
                <div className="admin-row-main">
                  <strong>{u.email}</strong>
                  <span className="muted small">
                    {fmtDate(u.createdAt)} · {u.deviceCount} cihaz · 7g {u.sessions7d} oturum
                  </span>
                </div>
                <div className="admin-badges">
                  {u.isAdmin && <span className="badge admin">yönetici</span>}
                  {u.disabled && <span className="badge danger">devre dışı</span>}
                  <span className={`badge plan-${u.plan}`}>{u.plan}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {selected && (
        <UserDrawer
          id={selected}
          onClose={() => setSelected(null)}
          onChanged={() => {
            loadUsers();
            void fetchOverview().then(setOv);
          }}
        />
      )}
    </Modal>
  );
}

function UserDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [u, setU] = useState<AdminUserDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [limitInput, setLimitInput] = useState("");
  const [notes, setNotes] = useState("");

  const load = () =>
    fetchUser(id)
      .then((d) => {
        setU(d);
        setLimitInput(d.deviceLimitOverride?.toString() ?? "");
        setNotes(d.notes ?? "");
      })
      .catch((e) => setErr(String(e.message ?? e)));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const apply = async (patch: Parameters<typeof patchUser>[1]) => {
    setBusy(true);
    setErr(null);
    try {
      const next = await patchUser(id, patch);
      setU(next);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal admin-drawer" role="dialog" aria-modal="true">
        <header>
          <h3 style={{ flex: 1 }}>{u?.email ?? "Kullanıcı"}</h3>
          <Button icon variant="ghost" onClick={onClose}>
            <Icon name="x" />
          </Button>
        </header>
        <div className="body">
          {!u ? (
            <span className="spinner" />
          ) : (
            <>
              {err && <p className="error small">{err}</p>}

              <div className="admin-field">
                <label>Plan</label>
                <div className="seg">
                  {(["free", "pro", "team"] as Plan[]).map((p) => (
                    <button key={p} className={u.plan === p ? "active" : ""} disabled={busy} onClick={() => apply({ plan: p })}>
                      {p}
                    </button>
                  ))}
                </div>
              </div>

              <div className="admin-field row">
                <label>Cihaz limiti (boş = plan varsayılanı)</label>
                <div className="admin-inline">
                  <input
                    type="number"
                    min={0}
                    value={limitInput}
                    onChange={(e) => setLimitInput(e.target.value)}
                    placeholder="—"
                  />
                  <Button
                    size="sm"
                    variant="subtle"
                    disabled={busy}
                    onClick={() => apply({ deviceLimitOverride: limitInput.trim() === "" ? null : Number(limitInput) })}
                  >
                    Kaydet
                  </Button>
                </div>
                <span className="muted small">Şu an: {u.deviceCount} cihaz kayıtlı</span>
              </div>

              <label className="admin-toggle">
                <input type="checkbox" checked={u.isAdmin} disabled={busy} onChange={(e) => apply({ isAdmin: e.target.checked })} />
                <span>Yönetici (limitleri aşar, bu paneli görür)</span>
              </label>

              <label className="admin-toggle">
                <input type="checkbox" checked={u.disabled} disabled={busy} onChange={(e) => apply({ disabled: e.target.checked })} />
                <span>Hesabı devre dışı bırak (giriş + bağlantı engellenir)</span>
              </label>

              <div className="admin-field">
                <label>Not</label>
                <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
                <Button size="sm" variant="subtle" disabled={busy} onClick={() => apply({ notes })}>
                  Notu kaydet
                </Button>
              </div>

              <div className="admin-field">
                <label>Cihazlar</label>
                {u.devices.length === 0 && <span className="muted small">Yok</span>}
                {u.devices.map((d) => (
                  <div key={d.id} className="admin-device">
                    <span className={`dot ${d.online ? "on" : "off"}`} />
                    <strong>{d.name}</strong>
                    <span className="muted small">
                      {d.id} · {fmtDate(d.lastSeenAt)}
                    </span>
                  </div>
                ))}
              </div>

              <div className="admin-field">
                <label>Son etkinlik</label>
                <div className="admin-events">
                  {u.recentEvents.length === 0 && <span className="muted small">Yok</span>}
                  {u.recentEvents.map((e, i) => (
                    <div key={i} className="admin-event">
                      <span>{e.kind}</span>
                      <time>{fmtDate(e.at)}</time>
                    </div>
                  ))}
                </div>
              </div>

              <div className="admin-danger">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    if (!confirm(`${u.email} hesabını ve tüm verilerini kalıcı olarak sil?`)) return;
                    setBusy(true);
                    deleteUser(id)
                      .then(() => {
                        onChanged();
                        onClose();
                      })
                      .catch((e) => {
                        setErr(e instanceof Error ? e.message : String(e));
                        setBusy(false);
                      });
                  }}
                >
                  Hesabı sil
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
