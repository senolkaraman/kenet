import { useState } from "react";
import { session } from "../core/session";
import { requestUnattendedTicket, setUnattended } from "../core/devices";
import { ApiError } from "../core/api";
import { Button, TextField } from "../components/primitives";
import { Icon } from "../components/Icon";
import { Modal } from "../components/Modal";
import { toast } from "../components/toast";

export function UnattendedConnectModal({
  deviceId,
  deviceName,
  onClose
}: {
  deviceId: string;
  deviceName: string;
  onClose: () => void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const connect = async () => {
    setBusy(true);
    setError("");
    try {
      const ticket = await requestUnattendedTicket(deviceId, password);
      onClose();
      session.connectTo(deviceId, deviceName, ticket);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Bağlanılamadı.");
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Gözetimsiz bağlan"
      icon={<Icon name="shield" />}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Vazgeç
          </Button>
          <Button variant="primary" onClick={connect} disabled={busy || !password}>
            {busy ? <span className="spinner" /> : <Icon name="link" size={15} />}
            Bağlan
          </Button>
        </>
      }
    >
      <p className="muted">
        <strong>{deviceName}</strong> için gözetimsiz erişim şifresini girin. Karşı tarafta kimsenin onayı gerekmez.
      </p>
      <TextField
        label="Gözetimsiz erişim şifresi"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && password && connect()}
        autoFocus
      />
      {error && (
        <p className="auth-error">
          <Icon name="x" size={13} /> {error}
        </p>
      )}
    </Modal>
  );
}

export function UnattendedSetupModal({
  deviceId,
  enabled,
  onClose
}: {
  deviceId: string;
  enabled: boolean;
  onClose: () => void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const apply = async (value: string | null) => {
    setBusy(true);
    try {
      await setUnattended(deviceId, value);
      toast(value ? "Gözetimsiz erişim açıldı" : "Gözetimsiz erişim kapatıldı", "ok");
      onClose();
    } catch {
      toast("İşlem başarısız", "warn");
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Bu bilgisayara gözetimsiz erişim"
      icon={<Icon name="shield" />}
      onClose={onClose}
      footer={
        <>
          {enabled && (
            <Button variant="danger" onClick={() => void apply(null)} disabled={busy} style={{ marginRight: "auto" }}>
              Kapat
            </Button>
          )}
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Vazgeç
          </Button>
          <Button variant="primary" onClick={() => void apply(password)} disabled={busy || password.length < 6}>
            {enabled ? "Şifreyi değiştir" : "Aç"}
          </Button>
        </>
      }
    >
      <p className="muted">
        Bu şifreyi bilen (ve aynı hesaba bağlı) biri, sen başında olmasan da bu bilgisayara bağlanabilir. Güçlü bir şifre
        seç ve kimseyle paylaşma.
      </p>
      <TextField
        label="Yeni gözetimsiz erişim şifresi"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        hint="En az 6 karakter"
        autoFocus
      />
      <p className="muted small">
        <Icon name="shield" size={12} /> Şifre sunucuda yalnızca özet (hash) olarak saklanır. Windows oturum açma / UAC
        ekranları henüz uzaktan denetlenemez.
      </p>
    </Modal>
  );
}
