# Kenet

Windows ile başlayan, masaüstü ve web istemcilerine genişleyebilen kişisel uzaktan erişim uygulaması prototipi.

## Paketler

- `apps/desktop`: Electron + React (Vite) tabanlı Windows masaüstü istemcisi.
- `apps/signal-server`: Hesap/cihaz REST API'si + JWT korumalı WebRTC sinyalleşme sunucusu (Cloud Run + Postgres).
- `apps/windows-agent`: `SendInput` ile fare/klavye/tekerlek olaylarını uygulayan .NET yardımcı süreci (self-contained, runtime gerektirmez).
- `packages/protocol`: Tüm istemcilerin paylaşacağı REST + sinyalleşme sözleşmeleri.

## Hesap sistemi

Kullanıcı e-posta/şifre ile kayıt olur. Her bilgisayar aynı hesapla giriş yapınca
sunucuya bir **cihaz** olarak kaydolur (kalıcı 6 haneli kod + cihaz token'ı). Bağlantı
yalnızca aynı hesaba bağlı cihazlar arasında kurulur. Sunucu şeması ilk açılışta
otomatik oluşturulur; dağıtım adımları [infra/DEPLOY-phase1.md](infra/DEPLOY-phase1.md).

Backend ortam değişkenleri: `DATABASE_URL` (Postgres), `JWT_SECRET`, `TURN_URL`,
`TURN_SHARED_SECRET`. TURN kimlik bilgileri `/turn-credentials` uç noktasından
geçerli bir token ile alınır.

## Masaüstü Arayüzü

Renderer bir React uygulamasıdır (`apps/desktop/src/renderer/src`):

- `core/` — REST istemcisi (`api.ts`), kimlik (`auth.ts`), cihazlar (`devices.ts`),
  sinyalleşme (`signal.ts`), oturum durum makinesi + WebRTC (`session.ts`),
  bağlantı istatistikleri (`stats.ts`), girdi köprüsü (`input.ts`), ayarlar.
- `screens/` — giriş, ana ekran, oturum ekranı (uzak görüntü + yüzen araç çubuğu + yan panel),
  ayarlar ve gelen istek pencereleri.
- `theme/` — CSS değişkenli tasarım sistemi; açık/koyu tema `data-theme` ile.

Oturum içinde: canlı gecikme/FPS/bant genişliği/aktarım türü göstergesi, tam ekran,
monitör seçimi, Ctrl+Alt+Del, metin panosu senkronu, kalite profili (otomatik/net/akıcı),
zayıf bağlantıda otomatik kalite düşürme, sürükle-bırak + onay tabanlı dosya aktarımı ve sohbet.

**Gerçek dosya kopyala-yapıştır** (Windows): bir dosyayı Gezgin'de kopyalayıp araç
çubuğundaki 📄 ikonuna basınca, karşı bilgisayarın panosuna gerçek bir dosya yolu olarak
düşer — orada Ctrl+V ile normal bir dosya yapıştırması olur. `Set-Clipboard`/`Get-Clipboard
-Format FileDropList` ile yapılır, ek bir araca gerek yoktur; hem görüntüleyen hem paylaşan
taraf gönderebilir.

Uygulama tepside çalışır, Windows başlangıcında açılabilir, güncellemeleri otomatik alır
(`infra/AUTO-UPDATE.md`).

## Yerel Çalıştırma

Backend için yerel bir Postgres gerekir (`DATABASE_URL` ya da standart `PG*` değişkenleri) ve
`JWT_SECRET`. İki PowerShell penceresinde, proje kökünde:

```powershell
$env:DATABASE_URL="postgresql://postgres:postgres@localhost:5432/remotedesk"; $env:JWT_SECRET="dev-secret"; npm run dev -w @kenet/signal-server
npm run dev -w @kenet/desktop
```

Kontroller ve Windows paket çıktısı:

```powershell
npm run check
npm test
npm run package:win
```

`apps/desktop/release` altında NSIS yükleyicisi ve taşınabilir Windows uygulaması oluşturulur. Kod imzalama sertifikası henüz yapılandırılmadığından Windows SmartScreen uyarısı gösterebilir.

## İnternet Üzerinden Kullanım

Her iki bilgisayarda uygulamayı açın, **aynı hesapla giriş yapın** (ilk seferinde kayıt olun).
Her cihaz otomatik olarak hesaba kaydolur ve "Cihazlarım" listesinde görünür. Listeden birine
tıklayarak veya altı haneli kodu girerek bağlanılır. Hedef bilgisayar bağlantıyı, ekran
paylaşımını ve fare/klavye denetimini ayrı ayrı onaylar.

Kendi sunucunuzu kullanmıyorsanız Ayarlar'daki sunucu adresine dokunmayın.

### Gözetimsiz erişim

"Bu cihaz" kartından **Gözetimsiz erişim**'e bir şifre tanımlayın. Bu şifreyi bilen ve aynı
hesaba bağlı biri, karşıda kimse olmasa da bu bilgisayara bağlanabilir. Uygulama tepside
çalışmaya devam eder (Ayarlar'dan Windows başlangıcında çalıştırılabilir). Şifre sunucuda
yalnızca özet olarak saklanır; doğrulama kısa ömürlü tek kullanımlık bilet ile yapılır.

> Windows oturum açma ve UAC güvenli masaüstü ekranları hâlâ uzaktan denetlenemez; bunun için
> Session 0 servisi gerekir (yol haritasında).

## Yönetici Uygulamaları

Hedef bilgisayarda açık yönetici uygulamalarını denetlemek gerektiğinde `Yönetici olarak aç` düğmesine yerel kullanıcı tıklar ve Windows UAC istemini fiziksel olarak onaylar. Yeni, yükseltilmiş Kenet penceresinde oturumu başlatın. Windows kilit ekranı ve UAC güvenli masaüstü uzaktan denetlenmez; bu ekranlarda yerel kullanıcı müdahalesi gerekir.

Üretim ortamında istemciyi `VITE_SERVER_URL=wss://alanadiniz` ile derleyin. İnternette NAT geçişi için kendi TURN sunucunuzu kullanın; örnek STUN sunucusu yalnızca geliştirme amaçlıdır.

Google Cloud Run ve coturn TURN altyapısı için hazır Terraform/Docker dosyaları [infra/gcp](infra/gcp) altında bulunur. Canlı kaynaklar, proje kimliği ve gizli TURN değeri verilmeden oluşturulmaz. Cloud Run dağıtımında TURN yapılandırması, kök URL'ye yapılan POST isteğindeki Kenet başlıklarıyla alınır.

## Güvenlik Notu

Bu sürüm: e-posta/şifre hesap sistemi (scrypt hash, HS256 JWT), hesaba bağlı cihaz defteri,
auth uç noktalarında rate limiting, sunucu tarafı bağlantı günlüğü (`/activity`), şifre sıfırlama
(e-posta teslimatı hariç), bağlantı isteği onayı, gözetimsiz erişim (sunucuda hash'lenmiş şifre +
kısa ömürlü tek kullanımlık bilet), ekran paylaşımı, alıcı onaylı dosya aktarımı ve açıkça izin
verilmiş fare/klavye denetimi içerir.

Eksikler: kod imzalama (SmartScreen), TURN kapasite/ölçekleme, çok-instance sinyal sunucusu,
Windows kilit ekranı / UAC güvenli masaüstü denetimi (Session 0 servisi gerekir), gerçek
e-posta teslimatı, faturalama.