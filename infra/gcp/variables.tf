variable "project_id" {
  type        = string
  description = "Google Cloud Project ID"
}

variable "region" {
  type        = string
  description = "Cloud Run region"
  default     = "us-central1"
}

variable "signal_image" {
  type        = string
  description = "Artifact Registry image URI for the signaling server"
}

variable "turn_shared_secret" {
  type        = string
  description = "Long random secret used to generate TURN credentials"
  sensitive   = true
}

variable "turn_machine_type" {
  type        = string
  default     = "e2-micro"
}

variable "signal_access_token" {
  type        = string
  description = "Personal secret required for device registration and TURN credentials"
  sensitive   = true
}