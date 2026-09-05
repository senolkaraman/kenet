import { env } from "./env.js";

export const emailConfigured = (): boolean => Boolean(env.resend.apiKey);

const layout = (title: string, bodyHtml: string) => `<!doctype html>
<html><body style="margin:0;background:#0d1014;font-family:system-ui,sans-serif;padding:32px 0">
<table role="presentation" width="100%"><tr><td align="center">
<table role="presentation" width="440" style="background:#14181e;border-radius:16px;overflow:hidden;border:1px solid #2b333f">
<tr><td style="padding:22px 28px;border-bottom:1px solid #222932">
  <span style="display:inline-block;width:26px;height:26px;border-radius:7px;background:linear-gradient(150deg,#ff5a3c,#ff8a5c);color:#fff;font-weight:800;font-size:12px;text-align:center;line-height:26px;vertical-align:middle">RD</span>
  <span style="color:#eef2f6;font-weight:700;font-size:15px;margin-left:8px;vertical-align:middle">Kenet</span>
</td></tr>
<tr><td style="padding:28px;color:#eef2f6">
  <h1 style="font-size:17px;margin:0 0 14px">${title}</h1>
  ${bodyHtml}
</td></tr>
</table></td></tr></table>
</body></html>`;

const codeBlock = (code: string) =>
  `<div style="margin:18px 0;padding:14px 16px;background:#0a0d11;border:1px solid #2b333f;border-radius:10px;font-family:ui-monospace,monospace;font-size:15px;letter-spacing:0.04em;color:#ff8a5c;word-break:break-all">${code}</div>`;

export const sendEmail = async (to: string, subject: string, html: string): Promise<boolean> => {
  if (!emailConfigured()) return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.resend.apiKey}` },
      body: JSON.stringify({ from: env.resend.from, to, subject, html })
    });
    if (!res.ok) {
      console.error("Resend error:", res.status, await res.text());
      return false;
    }
    return true;
  } catch (error) {
    console.error("Email send failed:", error instanceof Error ? error.message : error);
    return false;
  }
};

export const sendPasswordResetEmail = (to: string, token: string): Promise<boolean> =>
  sendEmail(
    to,
    "Kenet şifre sıfırlama kodu",
    layout(
      "Şifre sıfırlama",
      `<p style="color:#a9b4c0;font-size:13.5px;line-height:1.6">Bu isteği sen yapmadıysan güvenle yok sayabilirsin. Kod 1 saat geçerli.</p>
       ${codeBlock(token)}
       <p style="color:#a9b4c0;font-size:13px">Kenet uygulamasında "Şifremi unuttum" → bu kodu yapıştır.</p>`
    )
  );

export const sendInviteEmail = (to: string, orgName: string, token: string): Promise<boolean> =>
  sendEmail(
    to,
    `${orgName} ekibine davet edildin`,
    layout(
      "Ekip daveti",
      `<p style="color:#a9b4c0;font-size:13.5px;line-height:1.6"><strong style="color:#eef2f6">${orgName}</strong> ekibine katılman için davet edildin.</p>
       <p style="color:#a9b4c0;font-size:13px">Kenet uygulamasına bu e-posta ile giriş yap ya da hesap oluştur — davet otomatik görünecek.</p>`
    )
  ).then((sent) => {
    if (!sent) console.log(`[org-invite] ${to} -> org ${orgName} token ${token}`);
    return sent;
  });
