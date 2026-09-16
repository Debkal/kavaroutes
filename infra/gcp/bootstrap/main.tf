terraform {
  required_version = "= 1.12.6"
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
}

variable "project_id" {
  type = string
  validation {
    condition     = var.project_id == "kavaroutes"
    error_message = "Only the existing kavaroutes project is authorized."
  }
}

variable "state_bucket_name" {
  type = string
  validation {
    condition     = can(regex("^kavaroutes-wp013-state-[a-z0-9-]+$", var.state_bucket_name))
    error_message = "Use an explicit project-owned unique state bucket name."
  }
}

resource "google_storage_bucket" "state" {
  name                        = var.state_bucket_name
  location                    = "us-west1"
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  labels                      = { project = "kavaroutes", scope = "wp013", managed_by = "opentofu" }
  versioning { enabled = true }
  soft_delete_policy { retention_duration_seconds = 0 }
}

output "state_bucket" { value = google_storage_bucket.state.name }
