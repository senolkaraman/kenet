resource "google_project_service" "run" {
  service            = "run.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "artifact_registry" {
  service            = "artifactregistry.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "compute" {
  service            = "compute.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "secret_manager" {
  service            = "secretmanager.googleapis.com"
  disable_on_destroy = false
}

resource "google_service_account" "signal" {
  account_id   = "remotedesk-signal"
  display_name = "RemoteDesk signaling service"
}

resource "google_artifact_registry_repository" "remotedesk" {
  location      = var.region
  repository_id = "remotedesk"
  format        = "DOCKER"
  depends_on    = [google_project_service.artifact_registry]
}

resource "google_cloud_run_v2_service" "signal" {
  name     = "remotedesk-signal"
  location = var.region
  depends_on = [google_project_service.run, google_secret_manager_secret_iam_member.turn_secret_access]

  template {
    service_account = google_service_account.signal.email
    scaling {
      min_instance_count = 1
      max_instance_count = 1
    }
    containers {
      image = var.signal_image
      ports { container_port = 8080 }
      resources { cpu_idle = false }
      env { name = "TURN_URL" value = "turn:${google_compute_instance.turn.network_interface[0].access_config[0].nat_ip}:3478?transport=udp" }
      env {
        name = "TURN_SHARED_SECRET"
        value_source { secret_key_ref { secret = google_secret_manager_secret.turn_secret.secret_id version = "latest" } }
      }
      env {
        name = "SIGNAL_ACCESS_TOKEN"
        value_source { secret_key_ref { secret = google_secret_manager_secret.access_token.secret_id version = "latest" } }
      }
    }
  }
}

resource "google_cloud_run_v2_service_iam_member" "public" {
  name     = google_cloud_run_v2_service.signal.name
  location = google_cloud_run_v2_service.signal.location
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_compute_firewall" "turn" {
  name    = "remotedesk-turn"
  network = "default"
  allow { protocol = "udp" ports = ["3478", "49152-65535"] }
  allow { protocol = "tcp" ports = ["3478", "5349"] }
  target_tags = ["remotedesk-turn"]
  depends_on  = [google_project_service.compute]
}

resource "google_compute_instance" "turn" {
  name         = "remotedesk-turn"
  machine_type = var.turn_machine_type
  zone         = "${var.region}-a"
  tags         = ["remotedesk-turn"]

  boot_disk { initialize_params { image = "projects/debian-cloud/global/images/family/debian-12" } }
  network_interface { network = "default" access_config {} }

  metadata_startup_script = templatefile("${path.module}/turn-startup.sh.tftpl", {
    shared_secret = var.turn_shared_secret
  })
}

resource "google_secret_manager_secret" "turn_secret" {
  secret_id = "remotedesk-turn-shared-secret"
  replication { auto {} }
  depends_on = [google_project_service.secret_manager]
}

resource "google_secret_manager_secret_version" "turn_secret" {
  secret      = google_secret_manager_secret.turn_secret.id
  secret_data = var.turn_shared_secret
}

resource "google_secret_manager_secret" "access_token" {
  secret_id = "remotedesk-access-token"
  replication { auto {} }
  depends_on = [google_project_service.secret_manager]
}

resource "google_secret_manager_secret_version" "access_token" {
  secret      = google_secret_manager_secret.access_token.id
  secret_data = var.signal_access_token
}

resource "google_secret_manager_secret_iam_member" "turn_secret_access" {
  secret_id = google_secret_manager_secret.turn_secret.secret_id
  role     = "roles/secretmanager.secretAccessor"
  member   = "serviceAccount:${google_service_account.signal.email}"
}

resource "google_secret_manager_secret_iam_member" "access_token_access" {
  secret_id = google_secret_manager_secret.access_token.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.signal.email}"
}