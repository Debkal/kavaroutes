import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const permissions = ['compute.instances.create','compute.instances.setServiceAccount','compute.disks.create','compute.networks.create',
  'compute.subnetworks.create','compute.firewalls.create','storage.buckets.create','storage.buckets.list','iam.serviceAccounts.create',
  'iam.serviceAccounts.actAs','resourcemanager.projects.getIamPolicy','resourcemanager.projects.setIamPolicy','serviceusage.services.enable',
  'artifactregistry.repositories.create','secretmanager.secrets.create'];
try {
  let token;
  try { token = execFileSync(resolve('.tooling/google-cloud-sdk/bin/gcloud'), ['auth','print-access-token','--project=kavaroutes'], {
    encoding:'utf8',timeout:30000,stdio:['ignore','pipe','ignore'],env:{...process.env,CLOUDSDK_CONFIG:resolve('.tooling/gcloud-config'),CLOUDSDK_CORE_DISABLE_PROMPTS:'1'} }).trim(); }
  catch { throw new Error('CLOUD_AUTH_REQUIRED'); }
  async function query(url, body) {
    const response = await fetch(url,{method:body ? 'POST':'GET',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},
      ...(body ? {body:JSON.stringify(body)} : {}),signal:AbortSignal.timeout(20000)});
    if (!response.ok) return {status:response.status};
    return {status:response.status,data:await response.json()};
  }
  // testIamPermissions is a read-only check, despite using HTTP POST.
  const iam = await query('https://cloudresourcemanager.googleapis.com/v1/projects/kavaroutes:testIamPermissions',{permissions});
  const billing = await query('https://cloudbilling.googleapis.com/v1/projects/kavaroutes/billingInfo');
  const region = await query('https://compute.googleapis.com/compute/v1/projects/kavaroutes/regions/us-west1');
  const services = await query('https://serviceusage.googleapis.com/v1/projects/76306307395/services?filter=state:ENABLED&pageSize=200');
  const report = {scope:'read-only-cloud-preflight',checkedAt:new Date().toISOString(),project:'kavaroutes',region:'us-west1',
    iamHttpStatus:iam.status,requestedPermissions:permissions,grantedPermissions:iam.data?.permissions ?? [],
    missingPermissions:iam.status===200 ? permissions.filter(permission => !iam.data?.permissions?.includes(permission)) : permissions,
    billingHttpStatus:billing.status,billingEnabled:billing.data?.billingEnabled === true,
    regionHttpStatus:region.status,regionStatus:region.data?.status ?? 'UNKNOWN',
    quotas:(region.data?.quotas ?? []).filter(item=>['E2_CPUS','CPUS','INSTANCES','DISKS_TOTAL_GB','IN_USE_ADDRESSES'].includes(item.metric)),
    servicesHttpStatus:services.status,enabledServices:(services.data?.services ?? []).map(item=>item.config.name).sort(),
    servicesTruncated:Boolean(services.data?.nextPageToken),
    limits:['Not an organization-policy or per-resource IAM proof','No resource creation or API activation performed','No credit-balance or budget-alert claim']};
  await mkdir(resolve('.tooling/gcp'),{recursive:true});
  await writeFile(resolve('.tooling/gcp/preflight.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({iamHttpStatus:report.iamHttpStatus,missingPermissions:report.missingPermissions,billingEnabled:report.billingEnabled,
    regionStatus:report.regionStatus,enabledServiceCount:report.enabledServices.length}));
} catch(error) {
  console.error(error.message === 'CLOUD_AUTH_REQUIRED' ? 'CLOUD_AUTH_REQUIRED' : 'CLOUD_PREFLIGHT_FAILED');
  process.exitCode=1;
}
