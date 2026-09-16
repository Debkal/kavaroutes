import test from "node:test";
import assert from "node:assert/strict";
import { checkPlan } from "./check-plan.mjs";

const plan = (type, after, actions = ["create"]) => ({variables:{project_id:{value:"kavaroutes"}},resource_changes: [{mode:"managed", type, change:{actions,after:{project:"kavaroutes",...after}}}]});
test("notification channel must match the reviewed email input", () => {
  const values = {type:"email",enabled:true,display_name:"KavaRoutes WP013 operator",labels:{email_address:"synthetic@example.invalid"},user_labels:{scope:"wp013",managed_by:"opentofu"}};
  const p = plan("google_monitoring_notification_channel", values);
  assert.ok(checkPlan(p).includes("NOTIFICATION_CHANNEL_POLICY"));
  p.variables.alert_email = {value:"synthetic@example.invalid"};
  assert.deepEqual(checkPlan(p), []);
  for (const changed of [{type:"sms"},{enabled:false},{labels:{email_address:"other@example.invalid"}},{labels:{...values.labels,other:"unexpected"}}]) {
    const bad = structuredClone(p);
    Object.assign(bad.resource_changes[0].change.after, changed);
    assert.ok(checkPlan(bad).includes("NOTIFICATION_CHANNEL_POLICY"));
  }
});
test("health metrics and alerts stay closed and scoped", () => {
  const metric = {type:"custom.googleapis.com/kavaroutes/runtime/ready",metric_kind:"GAUGE",value_type:"DOUBLE",unit:"1",labels:[{key:"service",value_type:"STRING"}]};
  assert.deepEqual(checkPlan(plan("google_monitoring_metric_descriptor", metric)), []);
  for (const bad of [{...metric,type:"custom.googleapis.com/unapproved"},{...metric,labels:[{key:"patient",value_type:"STRING"}]}]) {
    assert.ok(checkPlan(plan("google_monitoring_metric_descriptor",bad)).includes("HEALTH_METRIC_POLICY"));
  }
  assert.ok(checkPlan(plan("google_monitoring_alert_policy",{enabled:true,conditions:[]})).includes("HEALTH_ALERT_POLICY"));
});
test("rejects unknown and destructive resource plans", () => {
  assert.ok(checkPlan(plan("google_service_account_key", {})).includes("UNREVIEWED_RESOURCE"));
  assert.ok(checkPlan(plan("google_storage_bucket", {}, ["delete"])).includes("DESTRUCTIVE_OR_UNKNOWN_ACTION"));
  assert.deepEqual(checkPlan({}), ["EMPTY_OR_INVALID_PLAN"]);
});
test("rejects public SSH and accepts the bounded IAP rule", () => {
  const v = {direction:"INGRESS", source_ranges:["35.235.240.0/20"], allow:[{protocol:"tcp",ports:["22"]}]};
  assert.deepEqual(checkPlan(plan("google_compute_firewall", v)), []);
  assert.ok(checkPlan(plan("google_compute_firewall", {...v,source_ranges:["0.0.0.0/0"]})).includes("PUBLIC_OR_EXTRA_INGRESS"));
});
test("rejects wrong projects and broad IAM roles", () => {
  assert.ok(checkPlan(plan("google_project_iam_member", {role:"roles/owner"})).includes("UNREVIEWED_ROLE"));
  assert.ok(checkPlan(plan("google_project_service", {project:"other",service:"compute.googleapis.com",disable_on_destroy:false})).includes("WRONG_OR_UNKNOWN_PROJECT"));
});
test("rejects unreviewed APIs and unsafe bucket cleanup", () => {
  assert.ok(checkPlan(plan("google_project_service", {service:"fcm.googleapis.com",disable_on_destroy:false})).includes("UNREVIEWED_API_OR_DISABLE"));
  assert.ok(checkPlan(plan("google_storage_bucket", {location:"US-WEST1",public_access_prevention:"enforced",uniform_bucket_level_access:true,force_destroy:true})).includes("BUCKET_POLICY"));
});
test("checks VM expiry against a fixed clock", () => {
  const now = Date.parse("2026-09-11T00:00:00Z");
  const v = {machine_type:"e2-medium",zone:"us-west1-b",boot_disk:[{initialize_params:[{size:30,type:"pd-standard"}]}],metadata:{"enable-oslogin":"TRUE","enable-oslogin-2fa":"FALSE","wp013-data-class":"synthetic-only"},scheduling:[{termination_time:"2026-09-12T00:00:00Z",instance_termination_action:"STOP",automatic_restart:false,on_host_maintenance:"MIGRATE",provisioning_model:"STANDARD"}]};
  assert.deepEqual(checkPlan(plan("google_compute_instance",v), now), []);
  const retained = plan("google_compute_instance", {...v,scheduling:[{...v.scheduling[0],termination_time:"2026-12-07T16:22:00Z"}]});
  retained.variables.hosting_mode = {value:"retained-development"};
  assert.deepEqual(checkPlan(retained, Date.parse("2026-09-13T16:22:00Z")), []);
  retained.resource_changes[0].change.after.scheduling[0].termination_time = "2026-12-08T16:22:00Z";
  assert.ok(checkPlan(retained, now).includes("VM_EXPIRY"));
  assert.ok(checkPlan(plan("google_compute_instance",{...v,metadata:{...v.metadata,"enable-oslogin":"FALSE"}}),now).includes("VM_ACCESS_OR_DATA_CLASS"));
  for (const invalid of [{on_host_maintenance:"TERMINATE"},{on_host_maintenance:undefined},{provisioning_model:"SPOT"},{preemptible:true}]) {
    assert.ok(checkPlan(plan("google_compute_instance", {...v,scheduling:[{...v.scheduling[0],...invalid}]}), now).includes("VM_E2_SCHEDULING"));
  }
  assert.ok(checkPlan({...plan("google_compute_instance",v),errored:true}, now).includes("FAILED_OR_INCOMPLETE_PLAN"));
  assert.ok(checkPlan(plan("google_compute_instance",v), now+48*3600000).includes("VM_EXPIRY"));
  assert.ok(checkPlan(plan("google_compute_instance",{...v,machine_type:"e2-standard-8"}), now).includes("VM_FOOTPRINT"));
});
