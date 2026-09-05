output "signal_url" {
  value       = google_cloud_run_v2_service.signal.uri
  description = "Use this URL with wss:// in the desktop app configuration."
}

output "turn_ip" {
  value       = google_compute_instance.turn.network_interface[0].access_config[0].nat_ip
  description = "Public IP of the coturn VM."
}