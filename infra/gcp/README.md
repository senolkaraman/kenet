# Google Cloud dağıtımı

Bu altyapı, tek Cloud Run örneğinde çalışan WebSocket sinyalleşme servisi ve `coturn` çalıştıran bir Compute Engine VM oluşturur. Sinyalleşme sunucusundaki bağlı istemci haritası bellekte tutulduğu için, kimlik/doğrulama ve kalıcı oturum katmanı eklenene kadar Cloud Run ölçeklemesi bilinçli biçimde bir örnekle sınırlıdır.

Mevcut `uzak-masaustu-sunucu` VM'i `us-central1-a` bölgesindeyse yeni VM oluşturmak yerine onu TURN sunucusu olarak yapılandırın. Bu durumda `google_compute_instance.turn` kaynağını Terraform uygulamasından önce içe aktarın veya kaynak bloğunu kaldırıp mevcut IP'yi `TURN_URL` ortam değişkeni olarak kullanın.
## Ön koşullar

- Google Cloud CLI ve Terraform `1.8+`.
- Faturalandırması etkin bir Google Cloud projesi.
- Docker veya Cloud Build ile oluşturulmuş sinyalleşme imajı.

## Dağıtım

Proje kökünden, kendi değerlerinizi yalnızca yerel terminalinizde kullanarak:

```powershell
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
gcloud services enable run.googleapis.com artifactregistry.googleapis.com compute.googleapis.com
gcloud artifacts repositories create remotedesk --repository-format=docker --location=europe-west3
gcloud builds submit --tag europe-west3-docker.pkg.dev/YOUR_PROJECT_ID/remotedesk/signal:0.1.0 --file apps/signal-server/Dockerfile .

Copy-Item infra/gcp/terraform.tfvars.example infra/gcp/terraform.tfvars
terraform -chdir=infra/gcp init
terraform -chdir=infra/gcp apply
```

`turn_shared_secret` ve `signal_access_token` için birbirinden farklı, en az 32 bayt rastgele değer kullanın. Bu dosya `.gitignore` tarafından korunur ve depoya eklenmez. `signal_access_token` değeri her RemoteDesk istemcisinde Kişisel erişim anahtarı alanına girilmelidir.

Terraform çıktısındaki `signal_url` değerini `wss://` şemasına çevirip uygulamayı `VITE_SIGNAL_URL` ile derleyin. İstemci, aynı adresin `/turn-credentials` uç noktasından kısa ömürlü HMAC TURN kimlik bilgilerini otomatik alır; istemciye sabit TURN parolası gömmeyin. Bu uç nokta kullanıcı kimlik doğrulaması eklenene kadar yalnızca özel/beta dağıtımda kullanılmalıdır.

## Geçici açık erişim penceresi

`SIGNAL_ACCESS_TOKEN` girmeden test etmek için `SIGNAL_OPEN_UNTIL` ortam değişkeni kullanılır.
Değer ya mutlak bir ISO 8601 zaman damgası (`2026-09-10T12:00:00Z`) ya da sunucu başlangıcına
göreli bir süredir (`+10m`, `+2h`, `+1d`). Pencere aktifken kayıt ve TURN kimlik bilgileri
anahtar istemeden verilir; süre dolunca sunucu sessizce yeniden `SIGNAL_ACCESS_TOKEN` ister
(yeniden dağıtım gerekmez).

Bu değişken sinyal sunucusu koduna eklendiği için önce yeni imajı derleyip dağıtın:

```powershell
$img = "us-central1-docker.pkg.dev/PROJE_ID/remotedesk/signal:0.1.9"
gcloud builds submit --tag $img --file apps/signal-server/Dockerfile .
gcloud run deploy remotedesk-signal-v2 --image $img --region us-central1 `
  --update-env-vars SIGNAL_OPEN_UNTIL=+15m
```

Durumu `GET /` yanıtındaki `auth` ve `openUntil` alanlarından doğrulayın. Kalıcı olarak
kapatmak için `--remove-env-vars=SIGNAL_OPEN_UNTIL`.