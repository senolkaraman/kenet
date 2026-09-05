import { useState } from "react";
import QRCode from "qrcode";
import { disableTotp, enableTotp, setupTotp } from "../core/auth";
import { ApiError } from "../core/api";
import { Button, TextField } from "../components/primitives";
import { Icon } from "../components/Icon";
import { Modal } from "../components/Modal";
import { toast } from "../components/toast";

type Step = "intro" | "scan" | "recovery";

/** Enrollment/disable flow for TOTP two-factor auth, opened from Settings. */
export function TwoFactorModal({ enabled, onClose }: { enabled: boolean; onClose: () => void }) {
  const [step, setStep] = useState<Step>("intro");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [secret, setSecret] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);

  const startSetup = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await setupTotp();
      setSecret(result.secret);
      setQrDataUrl(await QRCode.toDataURL(result.otpauthUrl, { margin: 1, width: 220 }));
      setStep("scan");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Kurulum başlatılamadı.");
    } finally {
      setBusy(false);
    }
  };

  const confirmCode = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await enableTotp(code.trim());
      setRecoveryCodes(result.recoveryCodes);
      setStep("recovery");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Kod hatalı.");
    } finally {
      setBusy(false);
    }
  };

  const doDisable = async () => {
    setBusy(true);
    setError("");
    try {
      await disableTotp(password);
      toast("İki adımlı doğrulama kapatıldı", "info");
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Şifre hatalı.");
    } finally {
      setBusy(false);
    }
  };

  if (step === "recovery") {
    return (
      <Modal
        title="Kurtarma kodların"
        icon={<Icon name="shield" />}
        footer={
          <Button variant="primary" block onClick={onClose}>
            Kaydettim, tamamla
          </Button>
        }
      >
        <p>
          Telefonunu kaybedersen bu kodlardan biriyle giriş yapabilirsin — her biri <strong>bir kez</strong>{" "}
          kullanılabilir. Şimdi bir yere (şifre yöneticisi, kasa) kaydet; bu ekran bir daha gösterilmeyecek.
        </p>
        <div className="recovery-grid">
          {recoveryCodes.map((c) => (
            <code key={c}>{c}</code>
          ))}
        </div>
        <Button
          variant="subtle"
          block
          onClick={() => {
            void navigator.clipboard.writeText(recoveryCodes.join("\n"));
            toast("Kodlar panoya kopyalandı", "ok");
          }}
        >
          <Icon name="copy" size={14} /> Kodları kopyala
        </Button>
      </Modal>
    );
  }

  if (enabled) {
    return (
      <Modal
        title="İki adımlı doğrulama"
        icon={<Icon name="shield" />}
        onClose={onClose}
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              Vazgeç
            </Button>
            <Button variant="danger" onClick={doDisable} disabled={busy || !password}>
              {busy ? <span className="spinner" /> : <Icon name="x" size={14} />} Kapat
            </Button>
          </>
        }
      >
        <p>İki adımlı doğrulama şu an açık. Kapatmak için hesap şifreni gir.</p>
        <TextField
          label="Şifre"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
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

  if (step === "scan") {
    return (
      <Modal
        title="İki adımlı doğrulamayı kur"
        icon={<Icon name="shield" />}
        onClose={onClose}
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              Vazgeç
            </Button>
            <Button variant="primary" onClick={confirmCode} disabled={busy || code.trim().length !== 6}>
              {busy ? <span className="spinner" /> : <Icon name="link" size={14} />} Etkinleştir
            </Button>
          </>
        }
      >
        <p>Google Authenticator, Authy gibi bir uygulamayla bu kodu tara:</p>
        {qrDataUrl && <img src={qrDataUrl} alt="TOTP QR" style={{ display: "block", margin: "12px auto", borderRadius: 8 }} />}
        <p className="muted small">
          Kamerayla tarayamıyorsan bu anahtarı elle gir: <code>{secret}</code>
        </p>
        <TextField
          label="Uygulamadaki 6 haneli kod"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          hint="Kurulumu tamamlamak için güncel kodu gir"
        />
        {error && (
          <p className="auth-error">
            <Icon name="x" size={13} /> {error}
          </p>
        )}
      </Modal>
    );
  }

  return (
    <Modal
      title="İki adımlı doğrulama"
      icon={<Icon name="shield" />}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Vazgeç
          </Button>
          <Button variant="primary" onClick={startSetup} disabled={busy}>
            {busy ? <span className="spinner" /> : <Icon name="shield" size={14} />} Kuruluma başla
          </Button>
        </>
      }
    >
      <p>
        Şifrenin yanına ikinci bir kilit ekler: giriş yaparken telefonundaki authenticator uygulamasından 6 haneli
        bir kod da isteriz. Şifren çalınsa/tahmin edilse bile hesabına girilemez.
      </p>
      {error && (
        <p className="auth-error">
          <Icon name="x" size={13} /> {error}
        </p>
      )}
    </Modal>
  );
}
