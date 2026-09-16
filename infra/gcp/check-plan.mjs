import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const types = new Set([
  "google_storage_bucket", "google_project_service", "google_compute_network",
  "google_compute_subnetwork", "google_service_account", "google_compute_firewall",
  "google_artifact_registry_repository", "google_artifact_registry_repository_iam_member",
  "google_storage_bucket_iam_member", "google_secret_manager_secret",
  "google_secret_manager_secret_iam_member", "google_project_iam_member", "google_compute_instance",
  "google_monitoring_notification_channel",
  "google_monitoring_metric_descriptor", "google_monitoring_alert_policy",
]);
const services = new Set([
  "compute.googleapis.com", "iam.googleapis.com", "iap.googleapis.com",
  "oslogin.googleapis.com", "artifactregistry.googleapis.com", "storage.googleapis.com",
  "secretmanager.googleapis.com", "logging.googleapis.com", "monitoring.googleapis.com",
]);
const roles = new Set([
  "roles/artifactregistry.reader", "roles/storage.objectUser", "roles/secretmanager.secretAccessor",
  "roles/logging.logWriter", "roles/monitoring.metricWriter",
]);

// Emits closed reason codes only: never print raw plans, values or provider diagnostics.
export function checkPlan(plan, now = Date.now()) {
  const failures = new Set();
  const fail = (code) => failures.add(code);
  if (plan?.errored === true || plan?.complete === false) fail("FAILED_OR_INCOMPLETE_PLAN");
  if (!Array.isArray(plan?.resource_changes) || plan.resource_changes.length === 0) return ["EMPTY_OR_INVALID_PLAN"];
  if (plan.variables?.project_id?.value !== "kavaroutes") fail("WRONG_OR_UNKNOWN_PROJECT");
  let instances = 0;
  for (const r of plan.resource_changes) {
    if (r.mode !== "managed" || !types.has(r.type)) { fail("UNREVIEWED_RESOURCE"); continue; }
    if (!Array.isArray(r.change?.actions) || r.change.actions.some(a => !["create", "no-op", "update"].includes(a))) fail("DESTRUCTIVE_OR_UNKNOWN_ACTION");
    const v = r.change?.after;
    if (!v || typeof v !== "object") { fail("MISSING_PLANNED_VALUES"); continue; }
    if (v.project !== undefined && v.project !== "kavaroutes") fail("WRONG_OR_UNKNOWN_PROJECT");
    if (r.type === "google_monitoring_metric_descriptor") {
      if (v.type !== "custom.googleapis.com/kavaroutes/runtime/ready" || v.metric_kind !== "GAUGE" ||
          v.value_type !== "DOUBLE" || v.unit !== "1" || v.labels?.length !== 1 ||
          v.labels[0].key !== "service" || v.labels[0].value_type !== "STRING") fail("HEALTH_METRIC_POLICY");
    }
    if (r.type === "google_monitoring_alert_policy") {
      const instance = plan.resource_changes.find(x => x.type === "google_compute_instance")?.change?.after?.instance_id;
      const channel = plan.resource_changes.find(x => x.type === "google_monitoring_notification_channel")?.change?.after?.name;
      const filter = `metric.type="custom.googleapis.com/kavaroutes/runtime/ready" AND resource.type="gce_instance" AND resource.labels.instance_id="${instance}"`;
      const threshold = v.conditions?.find(c => c.condition_threshold?.length)?.condition_threshold?.[0];
      const absent = v.conditions?.find(c => c.condition_absent?.length)?.condition_absent?.[0];
      if (!/^[0-9]+$/.test(instance ?? "") || !/^projects\/kavaroutes\/notificationChannels\/[0-9]+$/.test(channel ?? "") ||
          v.display_name !== "KavaRoutes WP013 runtime unavailable" || v.enabled !== true || v.combiner !== "OR" ||
          v.user_labels?.scope !== "wp013" || JSON.stringify(v.notification_channels) !== JSON.stringify([channel]) ||
          v.conditions?.length !== 2 || threshold?.filter !== filter || absent?.filter !== filter ||
          threshold?.comparison !== "COMPARISON_LT" || threshold?.threshold_value !== 1 || threshold?.duration !== "60s" ||
          threshold?.evaluation_missing_data !== "EVALUATION_MISSING_DATA_INACTIVE" ||
          threshold?.aggregations?.length !== 1 || threshold?.aggregations[0].alignment_period !== "60s" ||
          threshold?.aggregations[0].per_series_aligner !== "ALIGN_MIN" || threshold?.trigger?.[0]?.count !== 1 ||
          absent?.duration !== "300s" || absent?.trigger?.[0]?.count !== 1 ||
          v.alert_strategy?.[0]?.auto_close !== "1800s") fail("HEALTH_ALERT_POLICY");
    }
    if (r.type === "google_monitoring_notification_channel") {
      const email = plan.variables?.alert_email?.value;
      if (typeof email !== "string" || !/^[^ ,@]+@[^ ,@]+\.[^ ,@]+$/.test(email) ||
          v.type !== "email" || v.enabled !== true || v.labels?.email_address !== email ||
          Object.keys(v.labels ?? {}).length !== 1 || v.display_name !== "KavaRoutes WP013 operator" ||
          v.user_labels?.scope !== "wp013" || v.user_labels?.managed_by !== "opentofu") fail("NOTIFICATION_CHANNEL_POLICY");
    }
    if (v.role && !roles.has(v.role)) fail("UNREVIEWED_ROLE");
    if (v.member && (!v.member.startsWith("serviceAccount:") || !v.member.includes("kavaroutes-wp013-runtime@"))) fail("UNREVIEWED_PRINCIPAL");
    if (r.type === "google_project_service" && (!services.has(v.service) || v.disable_on_destroy !== false)) fail("UNREVIEWED_API_OR_DISABLE");
    if (r.type === "google_compute_network" && v.auto_create_subnetworks !== false) fail("AUTO_NETWORK");
    if (r.type === "google_compute_subnetwork" && (v.region !== "us-west1" || v.private_ip_google_access !== true)) fail("SUBNET_POLICY");
    if (r.type === "google_compute_firewall") {
      const rules = v.allow;
      if (v.direction !== "INGRESS" || JSON.stringify(v.source_ranges) !== '["35.235.240.0/20"]' ||
          rules?.length !== 1 || rules[0].protocol !== "tcp" || JSON.stringify(rules[0].ports) !== '["22"]') fail("PUBLIC_OR_EXTRA_INGRESS");
    }
    if (r.type === "google_storage_bucket" && (v.location?.toLowerCase() !== "us-west1" || v.public_access_prevention !== "enforced" || v.uniform_bucket_level_access !== true || v.force_destroy !== false)) fail("BUCKET_POLICY");
    if (r.type === "google_compute_instance") {
      instances++;
      const expiry = Date.parse(v.scheduling?.[0]?.termination_time);
      const disk = v.boot_disk?.[0]?.initialize_params?.[0];
      if (v.scheduling?.[0]?.on_host_maintenance !== "MIGRATE" || v.scheduling?.[0]?.provisioning_model !== "STANDARD" || v.scheduling?.[0]?.preemptible === true) fail("VM_E2_SCHEDULING");
      if (v.machine_type !== "e2-medium" || v.zone !== "us-west1-b" || disk?.size !== 30 || disk?.type !== "pd-standard") fail("VM_FOOTPRINT");
      const mode = plan.variables?.hosting_mode?.value ?? "ephemeral-test";
      const allowedExpiry = mode === "retained-development" ? expiry === Date.parse("2026-12-07T16:22:00Z") : mode === "ephemeral-test" && expiry <= now + 72 * 3600000;
      if (!Number.isFinite(expiry) || expiry <= now || !allowedExpiry || v.scheduling[0].instance_termination_action !== "STOP" || v.scheduling[0].automatic_restart !== false) fail("VM_EXPIRY");
      // Explicit human approval, 2026-09-13: keep this synthetic VM's extra SSH 2FA off.
      if (v.metadata?.["enable-oslogin"] !== "TRUE" || v.metadata?.["enable-oslogin-2fa"] !== "FALSE" || v.metadata?.["wp013-data-class"] !== "synthetic-only") fail("VM_ACCESS_OR_DATA_CLASS");
      if (v.metadata_startup_script || v.metadata?.["startup-script"] || v.metadata?.["ssh-keys"]) fail("UNREVIEWED_BOOTSTRAP_CONTENT");
    }
  }
  if (instances > 1) fail("MULTIPLE_VMS");
  return [...failures].sort();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const failures = checkPlan(JSON.parse(await readFile(process.argv[2], "utf8")));
    process.stdout.write(failures.length ? `${failures.join("\n")}\n` : "PLAN_BASELINE_CHECK_PASSED_REVIEW_STILL_REQUIRED\n");
    process.exitCode = failures.length ? 1 : 0;
  } catch {
    process.stderr.write("PLAN_READ_OR_PARSE_FAILED\n");
    process.exitCode = 1;
  }
}
