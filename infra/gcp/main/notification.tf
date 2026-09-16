# Human approved the existing billing/account email for failure alerts, 2026-09-13.
# Supply the address through TF_VAR_alert_email; never commit a personal address.
variable "alert_email" {
  type      = string
  default   = ""
  nullable  = false
  sensitive = true
  validation {
    condition     = var.alert_email == "" || can(regex("^[^ ,@]+@[^ ,@]+\\.[^ ,@]+$", var.alert_email))
    error_message = "Use the human-approved email address or leave notification setup disabled."
  }
}

resource "google_monitoring_notification_channel" "operator" {
  count        = nonsensitive(var.alert_email != "") ? 1 : 0
  display_name = "KavaRoutes WP013 operator"
  type         = "email"
  enabled      = true
  labels       = { email_address = var.alert_email }
  user_labels  = local.labels
  depends_on   = [google_project_service.required]
}
