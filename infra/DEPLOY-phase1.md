# Backend dağıtımı — Hesap sistemi + Postgres (Faz 1–2)

Sinyal sunucusu artık paylaşılan token yerine **hesap + JWT** kullanıyor ve
kullanıcı/cihaz verisini **Cloud SQL (Postgres)**'te tutuyor.

- Faz 2: **gözetimsiz erişim** (`/devices/:id/unattended-ticket`).
- Faz 4: **rate limiting** (auth), **bağlantı günlüğü** (`connection_events` tablosu,
  `POST/GET /activity`), **şifre sıfırlama** (`password_resets` tablosu, `/auth/forgot`,
  `/auth/reset` — e-posta henüz yok, token sunucu logunda görünür).
- Faz 5: **Stripe faturalama** + ekipler. Yeni tablolar: `organizations`, `org_members`,
  `org_invites`; `users`/`devices` genişletildi. Stripe env değişkenleri için ayrı belge:
  [BILLING.md](BILLING.md). Stripe yapılandırılmazsa uygulama Ücretsiz planla çalışır.

Şema migration'ları açılışta otomatik çalışır; ek adım yok. Deploy imajı: `signal:0.6.1`.

Tüm komutlar Cloud Shell'de, `remotedesk` deposu kök dizininde çalıştırılır.
Proje: `project-464d2ebf-1c2f-4ce1-b26`, bölge: `us-central1`.

## 1. Cloud SQL Postgres örneği (bir kez)

```bash
gcloud services enable sqladmin.googleapis.com

gcloud sql instances create remotedesk-db \
  --database-version=POSTGRES_16 --edition=ENTERPRISE \
  --tier=db-f1-micro --region=us-central1 --storage-size=10GB

# Güçlü bir parola üret ve NOT AL
DB_PASS=$(openssl rand -base64 24)
echo "DB_PASS=$DB_PASS"

gcloud sql users set-password postgres --instance=remotedesk-db --password="$DB_PASS"
gcloud sql databases create remotedesk --instance=remotedesk-db
```

Bağlantı adını al:
```bash
gcloud sql instances describe remotedesk-db --format='value(connectionName)'
# örn: project-464d2ebf-1c2f-4ce1-b26:us-central1:remotedesk-db
```

## 2. JWT gizli anahtarı

```bash
JWT_SECRET=$(openssl rand -base64 48)
echo "$JWT_SECRET" | gcloud secrets create remotedesk-jwt-secret --data-file=-
gcloud secrets add-iam-policy-binding remotedesk-jwt-secret \
  --member="serviceAccount:$(gcloud run services describe remotedesk-signal-v2 --region=us-central1 --format='value(spec.template.spec.serviceAccountName)')" \
  --role=roles/secretmanager.secretAccessor
```

## 3. Yeni imajı derle ve dağıt

```bash
CONN=$(gcloud sql instances describe remotedesk-db --format='value(connectionName)')
IMG=us-central1-docker.pkg.dev/project-464d2ebf-1c2f-4ce1-b26/remotedesk/signal:0.6.1

gcloud builds submit --tag $IMG --file apps/signal-server/Dockerfile .

gcloud run deploy remotedesk-signal-v2 \
  --image $IMG --region us-central1 \
  --min-instances=1 --max-instances=1 \
  --add-cloudsql-instances $CONN \
  --update-secrets JWT_SECRET=remotedesk-jwt-secret:latest \
  --update-env-vars "DATABASE_URL=postgresql://postgres:${DB_PASS}@/remotedesk?host=/cloudsql/${CONN}" \
  --remove-secrets SIGNAL_ACCESS_TOKEN 2>/dev/null || true
```

> `DATABASE_URL`'i parolayla birlikte env-var olarak yazmak yerine Secret Manager'a
> koymak daha güvenli; hızlı başlangıç için böyle bırakıldı.

> ⚠️ **`--min-instances=1 --max-instances=1` HER deploy'da zorunlu.** Bağlı cihaz listesi
> (`presence.ts`) yalnızca RAM'de tutuluyor — birden fazla örnek çalışırsa iki cihaz farklı
> örneklere denk gelip birbirini "çevrimdışı" görebilir (yaşandı, 2026-09-04). Bu bayrakları
> unutan bir deploy, `autoscaling.knative.dev/maxScale` değerini varsayılana (yüksek) geri
> döndürür. Çok-instance desteği gerekirse presence Redis/pub-sub'a taşınmalı.

Şema ilk açılışta otomatik oluşturulur (`migrate()`).

## 4. Doğrula

```bash
curl -s https://remotedesk-signal-v2-973464923624.us-central1.run.app/
# {"status":"ok","service":"remotedesk-signal"}

curl -s -X POST https://remotedesk-signal-v2-973464923624.us-central1.run.app/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"test@example.com","password":"supersecret"}'
# {"token":"...","user":{...}}
```

## 5. Masaüstü istemci

Yeni installer'da giriş ekranı var. İlk açılışta hesap oluştur / giriş yap.
Her bilgisayar aynı hesapla giriş yapınca "Cihazlarım" listesinde görünür;
listeden birine tıklayıp bağlanılır. Paylaşılan erişim anahtarı tamamen kalktı.

## Geri alma

Önceki revizyona dön:
```bash
gcloud run services update-traffic remotedesk-signal-v2 --region=us-central1 --to-revisions=remotedesk-signal-v2-00015-4dl=100
```
