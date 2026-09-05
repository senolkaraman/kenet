import { useEffect, useState } from "react";
import { session } from "../core/session";
import { useStore } from "../core/store";
import { settingsStore } from "../core/settings";
import { authStore, rotateThisDevice } from "../core/auth";
import { devicesStore, forgetDevice, refreshDevices, renameDevice, wakeDevice } from "../core/devices";
import { ApiError } from "../core/api";
import { Button } from "../components/primitives";
import { Icon } from "../components/Icon";
import { toast } from "../components/toast";
import { UnattendedConnectModal, UnattendedSetupModal } from "./Unattended";

function relativeTime(iso: string | null): string {
  if (!iso) return "hiç";
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 1) return "az önce";
  if (mins < 60) return `${mins} dk önce`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} sa önce`;
  return `${Math.round(hours / 24)} gün önce`;
}

export function Home({ online, onOpenSettings }: { online: boolean; onOpenSettings: () => void }) {
  const [code, setCode] = useState("");
  const phase = useStore(session.store, (s) => s.phase);
  const deviceName = useStore(settingsStore, (s) => s.deviceName);
  const thisDevice = useStore(authStore, (s) => s.device);
  const { devices } = useStore(devicesStore, (s) => s);
  const [auditEntries, setAuditEntries] = useState<Array<{ timestamp: string; event: string; details: string }>>([]);

  useEffect(() => {
    void window.kenetControl.listAudit().then(setAuditEntries);
    void refreshDevices();
  }, [phase]);

  const [unattendedConnect, setUnattendedConnect] = useState<{ id: string; name: string } | null>(null);
  const [unattendedSetup, setUnattendedSetup] = useState(false);
  const [rotating, setRotating] = useState(false);
  const requesting = phase === "requesting";
  const canConnect = online && /^[A-Za-z0-9]{6}$/.test(code.trim());
  const others = devices.filter((d) => d.id !== thisDevice?.id);
  const thisRecord = devices.find((d) => d.id === thisDevice?.id);

  const submit = () => {
    if (!canConnect) return;
    session.connectTo(code);
  };

  return (
    <main className="home">
      <section className="home-hero">
        {!online && (
          <div className="offline-banner" role="alert">
            <Icon name="wifi" size={17} />
            <div className="offline-banner-text">
              <strong>Sunucuya bağlanılıyor…</strong>
              <span>Birkaç saniye sürebilir. Sürerse Ayarlar'dan sunucu adresini kontrol edin.</span>
            </div>
            <Button variant="subtle" size="sm" onClick={onOpenSettings}>
              <Icon name="gear" size={14} /> Ayarlar
            </Button>
          </div>
        )}

        <div className="card connect-card">
          <div className="connect-head">
            <h2>Cihaza bağlan</h2>
            <p>Hesabındaki bir cihazı seç ya da altı haneli kodu gir. Hedef cihaz bağlantıyı ve denetimi ayrıca onaylar.</p>
          </div>
          <div className="code-row">
            <input
              className="code-input"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6))}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              placeholder="A1B2C3"
              maxLength={6}
              aria-label="Cihaz kodu"
            />
            <Button variant="primary" disabled={!canConnect || requesting} onClick={submit}>
              {requesting ? <span className="spinner" /> : <Icon name="link" />}
              {requesting ? "Onay bekleniyor" : "Bağlan"}
            </Button>
          </div>
        </div>

        <div className="card book-card">
          <h3>Cihazlarım</h3>
          <div className="book-list">
            {others.length === 0 && (
              <p className="muted small">
                Başka cihaz yok. Kenet'i diğer bilgisayarına kurup aynı hesapla giriş yap.
              </p>
            )}
            {others.map((d) => (
              <div key={d.id} className="book-item">
                <span className={`dot ${d.online ? "ok" : ""}`} title={d.online ? "Çevrimiçi" : "Çevrimdışı"} />
                <div className="book-main">
                  <input
                    className="book-name"
                    defaultValue={d.name}
                    onBlur={(e) => e.target.value.trim() && e.target.value !== d.name && void renameDevice(d.id, e.target.value.trim())}
                  />
                  <span className="book-meta">
                    {d.id} · {d.online ? "çevrimiçi" : relativeTime(d.lastSeenAt)}
                    {d.unattendedEnabled && " · gözetimsiz açık"}
                  </span>
                </div>
                {!d.online && d.wakeReady && (
                  <Button
                    size="sm"
                    variant="subtle"
                    disabled={!online}
                    title="Aynı ağdaki çevrimiçi bir cihaz üzerinden uyandırma paketi gönder"
                    onClick={async () => {
                      try {
                        const { via } = await wakeDevice(d.id);
                        toast(`Uyandırma sinyali gönderildi (${via} üzerinden).`, "ok");
                      } catch (err) {
                        toast(err instanceof ApiError ? err.message : "Uyandırılamadı.", "warn");
                      }
                    }}
                  >
                    <Icon name="power" size={14} /> Uyandır
                  </Button>
                )}
                {d.unattendedEnabled ? (
                  <Button size="sm" variant="subtle" disabled={!online} onClick={() => setUnattendedConnect({ id: d.id, name: d.name })}>
                    <Icon name="shield" size={14} /> Gözetimsiz
                  </Button>
                ) : (
                  <Button size="sm" variant="subtle" disabled={!online || !d.online} onClick={() => session.connectTo(d.id, d.name)}>
                    <Icon name="arrowRight" size={14} /> Bağlan
                  </Button>
                )}
                <Button size="sm" variant="ghost" icon title="Kaldır" onClick={() => void forgetDevice(d.id)}>
                  <Icon name="x" size={14} />
                </Button>
              </div>
            ))}
          </div>
        </div>
      </section>

      <aside className="home-side">
        <div className="card identity-card">
          <span className="identity-label">BU CİHAZ</span>
          <strong className="identity-code">{thisDevice?.id ?? "······"}</strong>
          <input
            className="identity-name"
            defaultValue={deviceName}
            onBlur={(e) => {
              const next = e.target.value.trim();
              if (next && next !== deviceName) {
                settingsStore.set({ deviceName: next });
                if (thisDevice) void renameDevice(thisDevice.id, next);
              }
            }}
            aria-label="Cihaz adı"
          />
          <Button
            block
            variant="subtle"
            disabled={!thisDevice}
            onClick={() => {
              if (thisDevice) void navigator.clipboard.writeText(thisDevice.id);
              toast("Cihaz kodu kopyalandı", "ok");
            }}
          >
            <Icon name="copy" /> Kodu kopyala
          </Button>
          <Button
            block
            variant="subtle"
            disabled={!thisDevice || rotating}
            onClick={async () => {
              if (!thisDevice) return;
              const sure = window.confirm(
                `Yeni bir kod alınsın mı? "${thisDevice.id}" kodu artık çalışmayacak, bunu bilen herkesin yeni kodu öğrenmesi gerekecek.`
              );
              if (!sure) return;
              setRotating(true);
              try {
                await rotateThisDevice();
                toast("Yeni cihaz kodu alındı", "ok");
              } catch {
                toast("Kod yenilenemedi. Tekrar deneyin.", "warn");
              } finally {
                setRotating(false);
              }
            }}
          >
            {rotating ? <span className="spinner" /> : <Icon name="refresh" />} Kodu yenile
          </Button>
          <button
            className="unattended-row"
            disabled={!thisDevice}
            data-on={thisRecord?.unattendedEnabled || undefined}
            onClick={() => setUnattendedSetup(true)}
          >
            <Icon name="shield" size={15} />
            <span>Gözetimsiz erişim</span>
            <strong>{thisRecord?.unattendedEnabled ? "Açık" : "Kapalı"}</strong>
          </button>
          <p className="identity-hint">
            <Icon name="shield" size={13} /> Bu kodu bilen herkes bağlantı isteği gönderebilir; bağlanan taraf
            ekranını sen onaylamadan göremez. Kodu paylaştığın kişiden emin değilsen kodu yenile.
          </p>
        </div>

        <div className="card">
          <h3>Yönetici uygulamaları</h3>
          <p className="muted">Yükseltilmiş uygulamaları denetlemek için yerel kullanıcı UAC istemini onaylamalıdır.</p>
          <Button
            block
            variant="subtle"
            style={{ marginTop: 12 }}
            onClick={async () => {
              const r = await window.kenetControl.requestElevation();
              toast(
                r.started ? "Windows UAC istemini bu bilgisayarda onaylayın." : r.reason ?? "Yönetici modu başlatılamadı.",
                r.started ? "info" : "warn"
              );
            }}
          >
            <Icon name="shield" /> Yönetici olarak aç
          </Button>
        </div>

        <div className="card">
          <h3>Son olaylar</h3>
          <ul className="audit-list">
            {auditEntries.length === 0 && <li className="muted">Henüz kayıt yok.</li>}
            {auditEntries.slice(0, 8).map((entry, i) => (
              <li key={i}>
                <span className="audit-dot" />
                <span className="audit-event">{eventLabel(entry.event)}</span>
                <span className="audit-detail">{entry.details}</span>
                <time>{new Date(entry.timestamp).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}</time>
              </li>
            ))}
          </ul>
        </div>
      </aside>

      {unattendedConnect && (
        <UnattendedConnectModal
          deviceId={unattendedConnect.id}
          deviceName={unattendedConnect.name}
          onClose={() => setUnattendedConnect(null)}
        />
      )}
      {unattendedSetup && thisDevice && (
        <UnattendedSetupModal
          deviceId={thisDevice.id}
          enabled={Boolean(thisRecord?.unattendedEnabled)}
          onClose={() => {
            setUnattendedSetup(false);
            void refreshDevices();
          }}
        />
      )}
    </main>
  );
}

function eventLabel(event: string): string {
  const labels: Record<string, string> = {
    "connection-requested": "İstek gönderildi",
    "connection-approved": "İstek onaylandı",
    "connection-rejected": "İstek reddedildi",
    "session-started": "Oturum başladı",
    "session-ended": "Oturum bitti",
    "file-sent": "Dosya gönderildi",
    "file-received": "Dosya alındı",
    "elevation-requested": "Yönetici modu"
  };
  return labels[event] ?? event;
}
