mock_provider "google" {}

variables {
  project_id         = "kavaroutes"
  backup_bucket_name = "kavaroutes-wp013-backup-synthetic-test"
  boot_image         = "projects/debian-cloud/global/images/debian-12-bookworm-v20260901"
  expires_at         = timeadd(timestamp(), "48h")
  runtime_ready      = true
}

run "private_development_plan" {
  command = plan
  assert {
    condition     = google_compute_instance.development.scheduling[0].on_host_maintenance == "MIGRATE" && google_compute_instance.development.scheduling[0].provisioning_model == "STANDARD"
    error_message = "Standard E2 requires MIGRATE; scheduled STOP expiry is independent."
  }
  assert {
    condition     = google_compute_instance.development.machine_type == "e2-medium" && google_compute_instance.development.boot_disk[0].initialize_params[0].size == 30
    error_message = "Unexpected VM footprint."
  }
  assert {
    condition     = google_compute_firewall.iap_ssh.source_ranges == toset(["35.235.240.0/20"]) && one(google_compute_firewall.iap_ssh.allow).ports == tolist(["22"]) && one(google_compute_firewall.iap_ssh.allow).protocol == "tcp"
    error_message = "Only IAP SSH may enter."
  }
  assert {
    condition     = google_compute_instance.development.scheduling[0].instance_termination_action == "STOP" && !google_compute_instance.development.scheduling[0].automatic_restart
    error_message = "VM expiry must stop and must not restart."
  }
  assert {
    condition     = google_storage_bucket.backup.public_access_prevention == "enforced" && !google_storage_bucket.backup.force_destroy
    error_message = "Backups must be private and not silently emptied."
  }
  assert {
    condition     = !contains(keys(google_project_service.required), "maps-backend.googleapis.com") && !contains(keys(google_project_service.required), "fcm.googleapis.com")
    error_message = "Live Maps/push are outside this deployment."
  }
}

run "unready_runtime_is_rejected" {
  command = plan
  variables { runtime_ready = false }
  expect_failures = [google_compute_instance.development]
}

run "wrong_project_is_rejected" {
  command = plan
  variables { project_id = "another-project" }
  expect_failures = [var.project_id]
}

run "unbounded_lifetime_is_rejected" {
  command = plan
  variables { expires_at = timeadd(timestamp(), "96h") }
  expect_failures = [google_compute_instance.development]
}

run "mutable_image_is_rejected" {
  command = plan
  variables { boot_image = "projects/debian-cloud/global/images/family/debian-12" }
  expect_failures = [var.boot_image]
}
