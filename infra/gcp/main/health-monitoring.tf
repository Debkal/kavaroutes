resource "google_monitoring_metric_descriptor" "runtime_ready" {
  count        = nonsensitive(var.alert_email != "") ? 1 : 0
  display_name = "KavaRoutes private runtime readiness"
  description  = "One closed readiness value per API/worker each minute; synthetic WP013 only."
  type         = "custom.googleapis.com/kavaroutes/runtime/ready"
  metric_kind  = "GAUGE"
  value_type   = "DOUBLE"
  unit         = "1"
  labels {
    key         = "service"
    value_type  = "STRING"
    description = "Closed api or worker service name."
  }
  depends_on = [google_project_service.required]
}

locals {
  health_filter = "metric.type=\"custom.googleapis.com/kavaroutes/runtime/ready\" AND resource.type=\"gce_instance\" AND resource.labels.instance_id=\"${google_compute_instance.development.instance_id}\""
}

resource "google_monitoring_alert_policy" "runtime_health" {
  count                 = nonsensitive(var.alert_email != "") ? 1 : 0
  display_name          = "KavaRoutes WP013 runtime unavailable"
  combiner              = "OR"
  enabled               = true
  severity              = "ERROR"
  user_labels           = local.labels
  notification_channels = [google_monitoring_notification_channel.operator[0].name]
  documentation {
    mime_type = "text/markdown"
    content   = "Private synthetic development only. Inspect the VM through IAP and run systemctl status kavaroutes-runtime.service and kavaroutes-health.timer. Check API/worker readiness and PostgreSQL health. Do not broaden ingress or enable production. Follow cloud.md for recovery. Human-approved hosting ends December 7 2026 at 16:22 UTC; VM budget is USD 100 for the full period. STOP does not delete retained storage."
  }
  conditions {
    display_name = "Runtime readiness failed"
    condition_threshold {
      filter                  = local.health_filter
      comparison              = "COMPARISON_LT"
      threshold_value         = 1
      duration                = "60s"
      evaluation_missing_data = "EVALUATION_MISSING_DATA_INACTIVE"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MIN"
      }
      trigger { count = 1 }
    }
  }
  conditions {
    display_name = "Runtime telemetry missing"
    condition_absent {
      filter   = local.health_filter
      duration = "300s"
      trigger { count = 1 }
    }
  }
  alert_strategy { auto_close = "1800s" }
  depends_on = [google_monitoring_metric_descriptor.runtime_ready]
}
