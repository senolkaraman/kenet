# RemoteDesk çalışma yönergeleri

- [x] Gereksinimler: Windows öncelikli; gelecekte macOS, Linux ve web istemcileri; internet üzerinden bağlantı.
- [x] İskelet: npm workspaces ile Electron istemcisi, WebSocket sinyalleşme sunucusu ve ortak protokol paketi.
- [x] Özelleştirme: Kalıcı cihaz kimliği, bağlantı onayı, WebRTC ekran paylaşımı, sohbet ve onaylı dosya aktarımı eklendi.
- [x] Derleme: TypeScript denetimi başarıyla tamamlandı.
- [ ] Başlatma: Sinyalleşme sunucusunu ve Electron istemcisini yerelde çalıştırın.
- [x] Belgeler ve CI: README güncel; tip denetimi, test ve derleme için GitHub Actions eklendi.

- Ortak ağ mesajları `@remotedesk/protocol` içinde tanımlanır.
- İstemciye uzaktan denetim eklenmeden önce kullanıcı onayı ve oturum yetkilendirmesi zorunludur.