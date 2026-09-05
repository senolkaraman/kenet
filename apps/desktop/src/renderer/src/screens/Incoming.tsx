import { useState } from "react";
import { session } from "../core/session";
import { settingsStore, updateSettings } from "../core/settings";
import { Button, Switch } from "../components/primitives";
import { Icon } from "../components/Icon";
import { Modal } from "../components/Modal";

interface Props {
  request: { from: string; name: string; requestId: string; fromDevice?: string };
}

export function IncomingRequest({ request }: Props) {
  const [allowControl, setAllowControl] = useState(false);
  const [trust, setTrust] = useState(false);
  const [busy, setBusy] = useState(false);

  const approve = async () => {
    setBusy(true);
    if (trust && request.fromDevice) {
      const current = settingsStore.get().trustedDevices;
      if (!current.includes(request.fromDevice)) {
        updateSettings({ trustedDevices: [...current, request.fromDevice] });
      }
    }
    await session.approveIncoming(allowControl || trust);
    setBusy(false);
  };

  return (
    <Modal
      title="Bağlantı isteği"
      icon={<Icon name="shield" />}
      footer={
        <>
          <Button variant="ghost" onClick={() => session.rejectIncoming()} disabled={busy}>
            Reddet
          </Button>
          <Button variant="primary" onClick={approve} disabled={busy}>
            {busy ? <span className="spinner" /> : <Icon name="link" size={15} />}
            Onayla ve paylaş
          </Button>
        </>
      }
    >
      <p>
        <strong>{request.name}</strong> <span className="muted">({request.from})</span> ekranınıza erişmek istiyor.
      </p>
      <div className="settings-row">
        <div>
          <strong>Fare ve klavye denetimine izin ver</strong>
          <p className="muted">Kapalıysa karşı taraf yalnızca izler.</p>
        </div>
        <Switch checked={allowControl || trust} onChange={setAllowControl} disabled={trust} />
      </div>
      {request.fromDevice && (
        <div className="settings-row">
          <div>
            <strong>Bu cihaza bir daha sorma</strong>
            <p className="muted">Bu cihazdan gelen istekleri otomatik onayla (tam denetimle). Ayarlar'dan geri alınır.</p>
          </div>
          <Switch checked={trust} onChange={setTrust} />
        </div>
      )}
      <p className="muted small">
        <Icon name="shield" size={12} /> Ekran görüntüsü uçtan uca şifrelenir ve yalnızca bu oturum boyunca aktarılır.
      </p>
    </Modal>
  );
}
