# Faturalama kurulumu (Stripe) — Faz 5

Planlar: **Ücretsiz** (3 cihaz, gözetimsiz erişim yok), **Pro** (sınırsız cihaz + gözetimsiz +
oturum kaydı), **Ekip** (Pro + koltuk başına faturalanan çoklu kullanıcı + paylaşımlı cihaz erişimi).

## 1. Stripe tarafı

1. [dashboard.stripe.com](https://dashboard.stripe.com) → **Product catalog**:
   - Ürün: "RemoteDesk Pro" → yinelenen fiyat (aylık) → `price_...` kimliğini kopyala → `STRIPE_PRICE_PRO`
   - Ürün: "RemoteDesk Ekip" → yinelenen fiyat, **koltuk başına** (per unit) → `STRIPE_PRICE_TEAM`
2. **Developers → API keys** → Secret key → `STRIPE_SECRET_KEY`
3. **Developers → Webhooks → Add endpoint**:
   - URL: `https://<sunucu>/billing/webhook`
   - Olaylar: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`
   - Signing secret → `STRIPE_WEBHOOK_SECRET`
4. **Settings → Billing → Customer portal** → aktif et (iptal, ödeme yöntemi, fatura geçmişi bu ekrandan yönetilir).

## 2. Cloud Run ortam değişkenleri

```bash
gcloud run services update remotedesk-signal-v2 --region=us-central1 \
  --set-env-vars="PUBLIC_URL=https://<sunucu-alan-adiniz>" \
  --update-secrets="STRIPE_SECRET_KEY=stripe-secret:latest,STRIPE_WEBHOOK_SECRET=stripe-webhook:latest" \
  --set-env-vars="STRIPE_PRICE_PRO=price_xxx,STRIPE_PRICE_TEAM=price_yyy"
```

`STRIPE_SECRET_KEY` ve `STRIPE_WEBHOOK_SECRET`'i Secret Manager'a koyun:
```bash
printf 'sk_live_...' | gcloud secrets create stripe-secret --data-file=-
printf 'whsec_...'   | gcloud secrets create stripe-webhook --data-file=-
```

`PUBLIC_URL` Stripe Checkout'un geri döneceği adrestir; `/billing/return` sayfası "uygulamaya
dönebilirsiniz" mesajını gösterir.

## 3. Nasıl çalışır

- Masaüstünde **Plan** çipi → "Pro'ya geç" / "Ekip kur" → sunucu Checkout Session açar →
  `shell.openExternal` ile tarayıcıda ödeme → webhook `users.plan` / `organizations.subscription_status`
  günceller → uygulama pencere odağında `/auth/me`'yi yeniden çeker.
- Cihaz limiti ve gözetimsiz erişim sunucuda `resolvePlan()` ile zorlanır (402 döner).
- Ekip: davet e-postası henüz yok — davet token'ı sunucu logunda (`[org-invite] ...`). Davetli
  giriş yapınca uygulamada "ekibe katıl" bandı görür.
- `STRIPE_SECRET_KEY` boşsa faturalama uç noktaları 503 döner; uygulama Ücretsiz planla sorunsuz çalışır.
