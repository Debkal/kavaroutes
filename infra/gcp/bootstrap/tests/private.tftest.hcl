mock_provider "google" {}
variables {
  project_id        = "kavaroutes"
  state_bucket_name = "kavaroutes-wp013-state-synthetic-test"
}
run "private_versioned_state" {
  command = plan
  assert {
    condition     = google_storage_bucket.state.versioning[0].enabled && google_storage_bucket.state.uniform_bucket_level_access && google_storage_bucket.state.public_access_prevention == "enforced" && !google_storage_bucket.state.force_destroy
    error_message = "State requires versioning, private access, and deliberate cleanup."
  }
}
run "wrong_project_is_rejected" {
  command = plan
  variables { project_id = "another-project" }
  expect_failures = [var.project_id]
}
