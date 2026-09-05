# Kenet Mobil — EAS (Expo bulut) build

EAS Build derlemeyi Expo'nun bulut sunucularında yapar; indirilebilir link + QR verir
(yerel Gradle beklemesi yok, 30 MB gönderim sınırı yok, iOS de aynı yoldan çıkar).

## Kurulum (bir kez, YAPILDI)

- `eas.json` — `development` / `preview` / `production` profilleri
- `app.json` — `owner: senolkaraman3452s-team`, `extra.eas.projectId`, `runtimeVersion appVersion`
- `expo-updates` kuruldu (OTA için)
- Repo artık **git deposu** (`git init` yapıldı — sadece yerel, GitHub yok). EAS monorepo'yu
  git kökünden arşivliyor, sunucuda kökte `npm ci` çalıştırıp `apps/mobile`'ı derliyor.
- `apps/mobile` monorepo'dan bağımsız: `@kenet/protocol` yerine yerel `src/core/protocol.ts`
  (yalnızca type kopyası).
- Kimlik: Expo access token'ı ile. Komut başında `EXPO_TOKEN=...` ya da kalıcı env var.

## Build alma

```
cd apps/mobile
EXPO_TOKEN=<token> npx eas build --platform android --profile preview
```

Bitince terminalde link + QR verir → telefondan aç, indir, kur.
(Token'ı her seferinde yazmamak için Windows'ta bir kez User env var yap:
`setx EXPO_TOKEN "<token>"` → yeni terminal aç.)

### OTA güncelleme (native değişiklik YOKSA)

```
cd apps/mobile
EXPO_TOKEN=<token> EAS_SKIP_AUTO_FINGERPRINT=1 npx eas update --branch preview --message "..."
```

Telefondaki uygulama bir sonraki açılışta JS'i günceller. Native modül eklediysen (yeni bir
`react-native-*` paketi) OTA yetmez, yeni `eas build` gerekir.

### iOS (ertelendi)

`EXPO_TOKEN=<token> npx eas build --platform ios --profile preview` — **Apple Developer Program
($99/yıl)** gerektirir. Gelir getirir hale gelince yapılacak.

## Notlar

- `preview` profili: dev-client YOK, tek başına çalışır, internal distribution (mağaza değil).
- `production` profili: Android `.aab` (Play Store).
- Ücretsiz katmanda ayda sınırlı sayıda build hakkı var (Android için genelde yeterli).
