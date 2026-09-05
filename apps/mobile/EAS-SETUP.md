# Kenet Mobil — EAS (Expo bulut) build

EAS Build derlemeyi Expo'nun bulut sunucularında yapar; sana indirilebilir bir link + QR verir
(yerel 15 dk'lık Gradle beklemesi yok, 30 MB gönderim sınırı yok, iOS de aynı yoldan çıkar).

`eas.json` ve `.easignore` hazır. Yapılması gerekenler (bir kez):

## 1. Expo hesabı + giriş

```
cd apps/mobile
npx eas login          # ücretsiz Expo hesabı — yoksa expo.dev'den 1 dk'da açılır
```

## 2. Projeyi bağla (projectId üretir, app.json'a yazar)

```
npx eas init
```

Bu `app.json` içine `expo.extra.eas.projectId` + `expo.owner` ekler. Commit'e dahil et.

## 3. OTA güncelleme kanalını kur (opsiyonel ama önerilir)

```
npx eas update:configure
```

Bundan sonra `npx eas update --branch preview` ile JS değişikliklerini native rebuild
YAPMADAN telefonlara itebilirsin.

## Build alma

Bu repo git deposu değil → her `eas build` komutunun başına `EAS_NO_VCS=1` koy
(EAS tüm klasörü arşivler, `.easignore` gereksizleri eler).

### Android APK (telefona kur)

```
EAS_NO_VCS=1 npx eas build --platform android --profile preview
```

Bitince terminalde bir link + QR verir → telefondan aç, indir, kur.

### iOS

```
EAS_NO_VCS=1 npx eas build --platform ios --profile preview
```

iOS için **Apple Developer Program ($99/yıl) gerekir** (cihaz kaydı + imzalama veya TestFlight).
EAS imzalama sihirbazını çalıştırır; Apple hesabına giriş ister. TestFlight için:
`EAS_NO_VCS=1 npx eas build -p ios --profile production` sonra `npx eas submit -p ios`.

## Notlar

- `preview` profili: dev-client YOK, tek başına çalışır, internal distribution (mağaza değil).
- `production` profili: Android `.aab` (Play Store), iOS store build.
- Monorepo: EAS `package-lock.json`'ı kökte görüp workspace'i otomatik çözer.
- `newArchEnabled: true` + reanimated 4 + react-native-webrtc → EAS'te de aynı şekilde derlenir.
