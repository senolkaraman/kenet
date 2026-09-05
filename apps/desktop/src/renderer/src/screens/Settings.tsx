import { useEffect, useState } from "react";
import { session } from "../core/session";
import { useStore } from "../core/store";
import { settingsStore, updateSettings } from "../core/settings";
import { authStore, logout } from "../core/auth";
import { Button, Switch, TextField } from "../components/primitives";
import { Icon } from "../components/Icon";
import { Modal } from "../components/Modal";
import { toast } from "../components/toast";
import { TwoFactorModal } from "./TwoFactor";

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const s = useStore(settingsStore, (v) => v);
  const account = useStore(authStore, (v) => v.user);
  const [serverUrl, setServerUrl] = useState(s.serverUrl);
  const [deviceName, setDeviceName] = useState(s.deviceName);
  const [startup, setStartup] = useState({ startWithWindows: false, runInBackground: true });
  const [twoFactorOpen, setTwoFactorOpen] = useState(false);

  useEffect(() => {
    void window.kenetControl.getStartupPrefs?.().then(setStartup);
  }, []);

  const applyStartup = (patch: Partial<typeof startup>) => {
    const next = { ...startup, ...patch };
    setStartup(next);
    void window.kenetControl.setStartupPrefs?.(next);
    updateSettings(patch);
  };

  const save = () => {
    if (!/^wss?:\/\/[^/]+/i.test(serverUrl.trim())) {
      toast("Geçerli bir ws:// veya wss:// adresi girin.", "warn");
      return;
    }
    updateSettings({
      serverUrl: serverUrl.trim().replace(/\/$/, ""),
      deviceName: deviceName.trim() || s.deviceName
    });
    void session.start();
    toast("Ayarlar kaydedildi", "ok");
    onClose();
  };

  return (
    <Modal
      title="Ayarlar"
      icon={<Icon name="gear" />}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Vazgeç
          </Button>
          <Button variant="primary" onClick={save}>
            Kaydet
          </Button>
        </>
      }
    >
      <div className="settings-row">
        <div>
          <strong>{account?.email}</strong>
          <p className="muted small">Giriş yapıldı</p>
        </div>
        <Button variant="ghost" size="sm" onClick={logout}>
          <Icon name="power" size={14} /> Çıkış yap
        </Button>
      </div>

      <div className="settings-row">
        <div>
          <strong>İki adımlı doğrulama</strong>
          <p className="muted small">{account?.totpEnabled ? "Açık" : "Kapalı"}</p>
        </div>
        <Button variant={account?.totpEnabled ? "danger" : "subtle"} size="sm" onClick={() => setTwoFactorOpen(true)}>
          <Icon name="shield" size={14} /> {account?.totpEnabled ? "Kapat" : "Etkinleştir"}
        </Button>
      </div>
      {twoFactorOpen && <TwoFactorModal enabled={Boolean(account?.totpEnabled)} onClose={() => setTwoFactorOpen(false)} />}

      <TextField label="Cihaz adı" value={deviceName} onChange={(e) => setDeviceName(e.target.value)} />
      <TextField
        label="Sunucu adresi"
        value={serverUrl}
        onChange={(e) => setServerUrl(e.target.value)}
        placeholder="wss://...run.app"
        hint="Kendi sunucunuzu kullanmıyorsanız değiştirmeyin."
        spellCheck={false}
      />

      <div className="settings-row">
        <span>Görüntü kalitesi tercihi</span>
        <div className="seg">
          {(["auto", "sharp", "smooth"] as const).map((mode) => (
            <button key={mode} data-on={s.quality === mode} onClick={() => updateSettings({ quality: mode })}>
              {mode === "auto" ? "Otomatik" : mode === "sharp" ? "Net" : "Akıcı"}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-row">
        <span>Oturum açılınca tam ekrana geç</span>
        <Switch checked={s.autoFullscreen} onChange={(v) => updateSettings({ autoFullscreen: v })} />
      </div>
      <div className="settings-row">
        <span>Denetimi almadan önce sor</span>
        <Switch checked={s.askBeforeControl} onChange={(v) => updateSettings({ askBeforeControl: v })} />
      </div>
      <div className="settings-row">
        <div>
          <span>Pano otomatik senkronu</span>
          <p className="muted small">Oturum boyunca iki tarafın panosu otomatik eşitlenir.</p>
        </div>
        <Switch checked={s.clipboardSync} onChange={(v) => updateSettings({ clipboardSync: v })} />
      </div>
      <div className="settings-row">
        <span>Gözetimsiz oturum boşta kalınca kapansın</span>
        <div className="seg">
          {([0, 10, 20, 30, 60] as const).map((m) => (
            <button
              key={m}
              data-on={s.unattendedIdleTimeoutMin === m}
              onClick={() => updateSettings({ unattendedIdleTimeoutMin: m })}
            >
              {m === 0 ? "Kapalı" : `${m} dk`}
            </button>
          ))}
        </div>
      </div>
      {s.trustedDevices.length > 0 && (
        <div className="settings-row">
          <div>
            <span>Güvenilir cihazlar</span>
            <p className="muted small">{s.trustedDevices.join(", ")} — bu cihazlardan gelen istekler sorulmadan onaylanıyor.</p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => updateSettings({ trustedDevices: [] })}>
            Temizle
          </Button>
        </div>
      )}
      <div className="settings-row">
        <div>
          <span>Windows başlangıcında çalıştır</span>
          <p className="muted small">Gözetimsiz erişim için bu bilgisayarın hep erişilebilir olması gerekir.</p>
        </div>
        <Switch checked={startup.startWithWindows} onChange={(v) => applyStartup({ startWithWindows: v })} />
      </div>
      <div className="settings-row">
        <span>Kapatınca tepside çalışmaya devam et</span>
        <Switch checked={startup.runInBackground} onChange={(v) => applyStartup({ runInBackground: v })} />
      </div>
    </Modal>
  );
}
