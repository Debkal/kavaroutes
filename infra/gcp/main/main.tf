terraform {
  required_version = "= 1.12.6"
  backend "gcs" {}
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "= 8.2.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = "us-west1"
  zone    = "us-west1-b"
}

locals {
  labels = { project = "kavaroutes", scope = "wp013", managed_by = "opentofu" }
  services = toset([
    "compute.googleapis.com", "iam.googleapis.com", "iap.googleapis.com",
    "oslogin.googleapis.com", "artifactregistry.googleapis.com",
    "storage.googleapis.com", "secretmanager.googleapis.com",
    "logging.googleapis.com", "monitoring.googleapis.com",
  ])
}

variable "project_id" {
  type = string
  validation {
    condition     = var.project_id == "kavaroutes"
    error_message = "Only the existing kavaroutes project is authorized."
  }
}
variable "backup_bucket_name" {
  type = string
  validation {
    condition     = can(regex("^kavaroutes-wp013-backup-[a-z0-9-]+$", var.backup_bucket_name))
    error_message = "Use an explicit project-owned unique backup bucket name."
  }
}
variable "boot_image" {
  type = string
  validation {
    condition     = can(regex("^projects/debian-cloud/global/images/debian-12-bookworm-v[0-9]+$", var.boot_image))
    error_message = "Pin a reviewed Debian 12 image version, never a mutable family."
  }
}
variable "expires_at" {
  type = string
  validation {
    condition     = can(formatdate("YYYY-MM-DD", var.expires_at))
    error_message = "Provide an explicit RFC3339 expiry."
  }
}
variable "runtime_ready" {
  description = "Leave false until CLD-006/007 runtime and image evidence passes."
  type        = bool
  default     = false
}

variable "hosting_mode" {
  type    = string
  default = "ephemeral-test"
  validation {
    condition     = contains(["ephemeral-test", "retained-development"], var.hosting_mode)
    error_message = "Use only the explicitly approved hosting mode."
  }
}

resource "google_project_service" "required" {
  for_each           = local.services
  service            = each.value
  disable_on_destroy = false
}

resource "google_compute_network" "development" {
  name                    = "kavaroutes-wp013"
  auto_create_subnetworks = false
  routing_mode            = "REGIONAL"
  depends_on              = [google_project_service.required]
}

resource "google_compute_subnetwork" "development" {
  name                     = "kavaroutes-wp013-west1"
  network                  = google_compute_network.development.id
  region                   = "us-west1"
  ip_cidr_range            = "10.77.0.0/24"
  private_ip_google_access = true
}

resource "google_service_account" "runtime" {
  account_id   = "kavaroutes-wp013-runtime"
  display_name = "KavaRoutes WP013 runtime"
  depends_on   = [google_project_service.required]
}

resource "google_compute_firewall" "iap_ssh" {
  name                    = "kavaroutes-wp013-iap-ssh"
  network                 = google_compute_network.development.id
  direction               = "INGRESS"
  source_ranges           = ["35.235.240.0/20"]
  target_service_accounts = [google_service_account.runtime.email]
  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

resource "google_artifact_registry_repository" "runtime" {
  location      = "us-west1"
  repository_id = "kavaroutes-wp013"
  format        = "DOCKER"
  labels        = local.labels
  docker_config { immutable_tags = true }
  depends_on = [google_project_service.required]
}

resource "google_artifact_registry_repository_iam_member" "pull" {
  location   = google_artifact_registry_repository.runtime.location
  repository = google_artifact_registry_repository.runtime.name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_storage_bucket" "backup" {
  name                        = var.backup_bucket_name
  location                    = "us-west1"
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  labels                      = local.labels
  soft_delete_policy { retention_duration_seconds = 0 }
}

resource "google_storage_bucket_iam_member" "backup" {
  bucket = google_storage_bucket.backup.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.runtime.email}"
}

# Metadata only: secret values are added outside OpenTofu to keep them out of state.
resource "google_secret_manager_secret" "runtime" {
  secret_id = "kavaroutes-wp013-runtime"
  labels    = local.labels
  replication {
    user_managed {
      replicas { location = "us-west1" }
    }
  }
  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret_iam_member" "runtime" {
  secret_id = google_secret_manager_secret.runtime.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_project_iam_member" "telemetry" {
  for_each = toset(["roles/logging.logWriter", "roles/monitoring.metricWriter"])
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_compute_instance" "development" {
  name         = "kavaroutes-dev-01"
  zone         = "us-west1-b"
  machine_type = "e2-medium"
  labels       = local.labels
  boot_disk {
    auto_delete = true
    initialize_params {
      image  = var.boot_image
      size   = 30
      type   = "pd-standard"
      labels = local.labels
    }
  }
  network_interface {
    subnetwork = google_compute_subnetwork.development.id
    access_config { network_tier = "PREMIUM" }
  }
  service_account {
    email  = google_service_account.runtime.email
    scopes = ["https://www.googleapis.com/auth/cloud-platform"]
  }
  metadata = {
    enable-oslogin         = "TRUE"
    enable-oslogin-2fa     = "FALSE"
    block-project-ssh-keys = "TRUE"
    serial-port-enable     = "FALSE"
    wp013-expires-at       = var.expires_at
    wp013-data-class       = "synthetic-only"
  }
  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }
  scheduling {
    automatic_restart = false
    # Standard E2 requires live migration; scheduled expiry below still stops it.
    on_host_maintenance         = "MIGRATE"
    provisioning_model          = "STANDARD"
    termination_time            = var.expires_at
    instance_termination_action = "STOP"
  }
  lifecycle {
    precondition {
      condition     = var.runtime_ready
      error_message = "CLD-006/007 runtime evidence must pass before provisioning the VM."
    }
    precondition {
      condition     = timecmp(var.expires_at, plantimestamp()) > 0 && (var.hosting_mode == "retained-development" ? var.expires_at == "2026-12-07T16:22:00Z" : timecmp(var.expires_at, timeadd(plantimestamp(), "72h")) <= 0)
      error_message = "Use the fixed human-approved development expiry, or a test expiry within 72 hours."
    }
  }
  depends_on = [google_compute_firewall.iap_ssh]
}

output "instance_name" { value = google_compute_instance.development.name }
output "runtime_identity" { value = google_service_account.runtime.email }
