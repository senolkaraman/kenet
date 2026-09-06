import { useEffect, useState } from "react";
import { useStore } from "./core/store";
import { session } from "./core/session";
import { settingsStore, updateSettings } from "./core/settings";
import { authStore, bootstrapAuth, ensureDevice, logout, refreshMe } from "./core/auth";
import { refreshDevices } from "./core/devices";
import { watchForPlanChange } from "./core/billing";
import { orgStore, refreshOrgs, acceptInvite } from "./core/orgs";
import { Icon } from "./components/Icon";
import { Button } from "./components/primitives";
import { Toaster, useMessageToasts } from "./components/toast";
import { Login } from "./screens/Login";
import { Home } from "./screens/Home";
import { Session } from "./screens/Session";
import { SettingsModal } from "./screens/Settings";
import { IncomingRequest } from "./screens/Incoming";
import { ActivityModal } from "./screens/Activity";
import { BillingModal } from "./screens/Billing";
import { AdminModal } from "./screens/Admin";
import { toast } from "./components/toast";

const inSession = new Set(["connecting", "reconnecting", "active"]);

export function App() {
  const authStatus = useStore(authStore, (s) => s.status);
  const account = useStore(authStore, (s) => s.user);
  const device = useStore(authStore, (s) => s.device);
  const deviceError = useStore(authStore, (s) => s.deviceError);
  const phase = useStore(session.store, (s) => s.phase);
  const registered = useStore(session.store, (s) => s.registered);
  const message = useStore(session.store, (s) => s.message);
  const quality = useStore(session.store, (s) => s.quality);
  const incoming = useStore(session.store, (s) => s.incoming);
  const theme = useStore(settingsStore, (s) => s.theme);
  const invites = useStore(orgStore, (s) => s.invites);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [billingOpen, setBillingOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);

  useEffect(() => {
    void bootstrapAuth();
    session.start();
    const stopPlanWatch = watchForPlanChange();
    // A single-owner PC should stay logged in indefinitely: renew the session token periodically
    // too (not just on window focus, via billing.ts's watchForPlanChange) so a long-running
    // background/tray instance (unattended access) never silently drifts toward its TTL cliff.
    const renewInterval = window.setInterval(() => void refreshMe(), 12 * 60 * 60 * 1000);
    // Stop Electron from navigating away when a file is dropped outside a drop zone.
    const block = (e: DragEvent) => e.preventDefault();
    window.addEventListener("dragover", block);
    window.addEventListener("drop", block);
    return () => {
      stopPlanWatch();
      window.clearInterval(renewInterval);
      window.removeEventListener("dragover", block);
      window.removeEventListener("drop", block);
    };
  }, []);

  useEffect(() => {
    if (authStatus === "signedIn") {
      void refreshDevices();
      void refreshOrgs();
    }
  }, [authStatus]);

  useMessageToasts(message);
  useEffect(() => {
    if (deviceError) toast(deviceError, "warn");
  }, [deviceError]);

  if (authStatus === "loading") {
    return (
      <div className="app" style={{ gridTemplateRows: "1fr" }}>
        <div style={{ display: "grid", placeItems: "center" }}>
          <span className="spinner big" />
        </div>
      </div>
    );
  }

  if (authStatus === "signedOut") return <Login />;

  const online = registered && !inSession.has(phase);
  const connState = inSession.has(phase)
    ? { dot: quality === "bad" ? "bad" : quality === "warn" ? "warn" : "ok", text: phase === "active" ? "Oturum etkin" : "Bağlanıyor…" }
    : registered
      ? { dot: "ok", text: "Çevrimiçi" }
      : { dot: "bad", text: "Bağlanıyor…" };

  return (
    <div className="app">
      <header className="titlebar">
        <div className="logo">
          <span className="glyph">K</span>
          Kenet
        </div>
        <span className="conn-chip no-drag">
          <span className={`dot ${connState.dot}`} />
          {connState.text}
        </span>
        {device && (
          <span className="conn-chip no-drag" title="Bu cihazın kodu">
            <Icon name="shield" size={13} />
            {device.id}
          </span>
        )}
        <div className="spacer" />
        <button
          className={`plan-chip no-drag ${account?.plan ?? "free"}`}
          title="Plan ve ekip"
          onClick={() => setBillingOpen(true)}
        >
          <Icon name="bolt" size={12} />
          {account?.plan === "team" ? "Ekip" : account?.plan === "pro" ? "Pro" : "Ücretsiz"}
          {invites.length > 0 && <span className="chip-badge">{invites.length}</span>}
        </button>
        <span className="conn-chip no-drag" title={account?.email}>
          <Icon name="shield" size={13} />
          {account?.email?.split("@")[0]}
        </span>
        <Button
          icon
          variant="ghost"
          title={theme === "dark" ? "Aydınlık tema" : "Karanlık tema"}
          onClick={() => updateSettings({ theme: theme === "dark" ? "light" : "dark" })}
        >
          <Icon name={theme === "dark" ? "sun" : "moon"} />
        </Button>
        <Button icon variant="ghost" title="Hesap etkinliği" onClick={() => setActivityOpen(true)}>
          <Icon name="wifi" />
        </Button>
        {account?.isAdmin && (
          <Button icon variant="ghost" title="Yönetici paneli" onClick={() => setAdminOpen(true)}>
            <Icon name="shield" />
          </Button>
        )}
        <Button icon variant="ghost" title="Ayarlar" onClick={() => setSettingsOpen(true)}>
          <Icon name="gear" />
        </Button>
        <Button icon variant="ghost" title="Çıkış" onClick={logout}>
          <Icon name="power" />
        </Button>
        <Button icon variant="ghost" title="Simge durumuna küçült" onClick={() => window.kenetControl.minimizeWindow?.()}>
          <Icon name="minimize" />
        </Button>
      </header>

      {deviceError && !device && !inSession.has(phase) && (
        <div className="invite-banner" style={{ background: "color-mix(in srgb, var(--danger) 12%, var(--bg-1))", borderColor: "color-mix(in srgb, var(--danger) 38%, transparent)" }}>
          <Icon name="x" size={15} />
          <span>
            <strong>Bu cihaz kaydedilemedi:</strong> {deviceError}
          </span>
          <Button size="sm" variant="subtle" onClick={() => void ensureDevice()}>
            Tekrar dene
          </Button>
          <Button size="sm" variant="primary" onClick={() => setBillingOpen(true)}>
            Planı gör
          </Button>
        </div>
      )}

      {invites.length > 0 && !inSession.has(phase) && (
        <div className="invite-banner">
          <Icon name="shield" size={15} />
          <span>
            <strong>{invites[0].orgName}</strong> ekibine davet edildin.
          </span>
          <Button
            size="sm"
            variant="primary"
            onClick={async () => {
              try {
                await acceptInvite(invites[0].id);
                await Promise.all([refreshOrgs(), bootstrapAuth()]);
                toast("Ekibe katıldın", "ok");
              } catch {
                toast("Davet kabul edilemedi", "warn");
              }
            }}
          >
            Katıl
          </Button>
        </div>
      )}

      {inSession.has(phase) ? <Session /> : <Home online={online} onOpenSettings={() => setSettingsOpen(true)} />}

      {incoming && <IncomingRequest request={incoming} />}
      {activityOpen && <ActivityModal onClose={() => setActivityOpen(false)} />}
      {billingOpen && <BillingModal onClose={() => setBillingOpen(false)} />}
      {adminOpen && <AdminModal onClose={() => setAdminOpen(false)} />}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      <Toaster />
    </div>
  );
}
