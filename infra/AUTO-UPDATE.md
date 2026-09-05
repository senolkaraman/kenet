# Otomatik güncelleme kurulumu (Faz 3)

Masaüstü uygulaması `electron-updater` içeriyor ve pakete `app-update.yml`
gömülüyse başlangıçta + 6 saatte bir güncelleme kontrol eder, indirir ve
"yeniden başlat" diye sorar. Şu an bir yayın hedefi tanımlı olmadığı için
sessizce devre dışı.

## Etkinleştirmek için

1. Statik bir dosya sunucusu seç (GCS bucket, S3, herhangi bir web sunucusu).
   Örn: `https://updates.remotedesk.app/win/`

2. `apps/desktop/package.json` içindeki `build` bloğuna ekle:

   ```json
   "publish": [
     { "provider": "generic", "url": "https://updates.remotedesk.app/win" }
   ]
   ```

3. Sürüm çıkarırken:

   ```powershell
   npm run package:win
   # release/ altındaki şu dosyaları sunucuya yükle:
   #   RemoteDesk Setup <sürüm>.exe
   #   latest.yml
   #   *.blockmap
   ```

4. `latest.yml` her sürümde güncellenir; istemciler onu okuyup yeni sürümü fark eder.

## Kod imzalama (SmartScreen)

İmzalanmamış güncellemeler de indirilir ama NSIS her seferinde SmartScreen
uyarısı gösterir. Bir OV/EV sertifikası alıp `build.win` içine ekleyin:

```json
"win": { "certificateFile": "cert.pfx", "certificatePassword": "${env.CSC_KEY_PASSWORD}" }
```

GitHub Releases kullanılacaksa `provider: "github"` daha az kurulum gerektirir.
