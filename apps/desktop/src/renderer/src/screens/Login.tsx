import { useState } from "react";
import { forgotPassword, login, register, resetPassword, verifyTotp } from "../core/auth";
import { ApiError } from "../core/api";
import { Button, TextField } from "../components/primitives";
import { Icon } from "../components/Icon";

type Mode = "login" | "register" | "forgot" | "reset" | "totp";

export function Login() {
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [pendingToken, setPendingToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (mode === "login") {
        const challenge = await login(email.trim(), password);
        if (challenge) {
          setPendingToken(challenge.pendingToken);
          setMode("totp");
        }
      } else if (mode === "register") await register(email.trim(), password);
      else if (mode === "forgot") {
        await forgotPassword(email.trim());
        setNotice("E-posta adresi kayıtlıysa sıfırlama bağlantısı gönderildi.");
        setMode("reset");
      } else if (mode === "totp") {
        await verifyTotp(pendingToken, totpCode.trim());
      } else {
        await resetPassword(token.trim(), password);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Bir hata oluştu.");
    } finally {
      setBusy(false);
    }
  };

  const titles: Record<Mode, string> = {
    login: "Hesabınıza giriş yapın",
    register: "Yeni hesap oluşturun",
    forgot: "Şifrenizi sıfırlayın",
    reset: "Yeni şifre belirleyin",
    totp: "İki adımlı doğrulama"
  };
  const submitLabels: Record<Mode, string> = {
    login: "Giriş yap",
    register: "Hesap oluştur",
    forgot: "Sıfırlama bağlantısı gönder",
    reset: "Şifreyi güncelle",
    totp: "Doğrula"
  };

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="glyph">K</span>
          <div>
            <h1>Kenet</h1>
            <p className="muted">{titles[mode]}</p>
          </div>
        </div>

        <form onSubmit={run} className="auth-form">
          {mode === "totp" && (
            <TextField
              label="Doğrulama kodu"
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value.replace(/[^0-9A-Za-z-]/g, "").slice(0, 11))}
              hint="Authenticator uygulamandaki 6 haneli kod, ya da kurtarma kodlarından biri"
              required
              autoFocus
            />
          )}
          {mode !== "reset" && mode !== "totp" && (
            <TextField
              label="E-posta"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
          )}
          {mode === "reset" && (
            <TextField
              label="Sıfırlama kodu"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              hint="E-postadaki bağlantıdaki kod"
              required
              autoFocus
            />
          )}
          {mode !== "forgot" && mode !== "totp" && (
            <TextField
              label={mode === "reset" ? "Yeni şifre" : "Şifre"}
              type="password"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              hint={mode === "register" || mode === "reset" ? "En az 8 karakter" : undefined}
              required
            />
          )}
          {notice && (
            <p className="auth-notice">
              <Icon name="shield" size={13} /> {notice}
            </p>
          )}
          {error && (
            <p className="auth-error">
              <Icon name="x" size={13} /> {error}
            </p>
          )}
          <Button variant="primary" block type="submit" disabled={busy}>
            {busy ? <span className="spinner" /> : <Icon name="arrowRight" size={15} />}
            {submitLabels[mode]}
          </Button>
        </form>

        <div className="auth-links">
          {mode === "login" && (
            <>
              <button className="auth-switch" onClick={() => setMode("register")}>
                Hesabın yok mu? Kayıt ol
              </button>
              <button className="auth-switch" onClick={() => setMode("forgot")}>
                Şifremi unuttum
              </button>
            </>
          )}
          {mode !== "login" && (
            <button className="auth-switch" onClick={() => setMode("login")}>
              Girişe dön
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
