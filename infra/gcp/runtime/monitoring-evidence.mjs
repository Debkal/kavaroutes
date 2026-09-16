// Read-only cloud evidence; credentials and provider bodies are never printed.
import { execFileSync } from 'node:child_process';
const root = '/home/chewy/kavaroutes';
const env = {...process.env, CLOUDSDK_CONFIG:`${root}/.tooling/gcloud-config`, CLOUDSDK_CORE_DISABLE_PROMPTS:'1'};
try {
  const token = execFileSync(`${root}/.tooling/google-cloud-sdk/bin/gcloud`, ['auth','print-access-token','--project=kavaroutes'],
    {env, encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']}).trim();
  const start = new Date(Date.now()-30*60*1000).toISOString();
  const filter = 'metric.type="custom.googleapis.com/kavaroutes/runtime/ready" AND resource.type="gce_instance" AND resource.labels.instance_id="1169005056344205029"';
  const params = new URLSearchParams({filter,'interval.startTime':start,'interval.endTime':new Date().toISOString(),pageSize:'100'});
  const metricResponse = await fetch(`https://monitoring.googleapis.com/v3/projects/kavaroutes/timeSeries?${params}`,
    {headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000),redirect:'error'});
  if (!metricResponse.ok) throw Error();
  const metrics = await metricResponse.json();
  const series = (metrics.timeSeries ?? []).map(s => ({service:['api','worker'].includes(s.metric?.labels?.service) ? s.metric.labels.service : 'INVALID',
    points:s.points?.slice(0,12).map(p=>({time:p.interval?.endTime,ready:p.value?.doubleValue===1}))}));
  console.log(JSON.stringify({result:'CLOUD_HEALTH_METRICS',series,more:Boolean(metrics.nextPageToken)}));
  const response = await fetch('https://monitoring.googleapis.com/v3/projects/kavaroutes/alerts?pageSize=50',
    {headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000),redirect:'error'});
  if (!response.ok) { console.log(JSON.stringify({result:'CLOUD_ALERT_READ_UNAVAILABLE',status:response.status})); process.exitCode=1; }
  else {
    const data = await response.json();
    const alerts = (data.alerts ?? []).filter(a=>JSON.stringify(a).includes('13582796355544985256'));
    console.log(JSON.stringify({result:'CLOUD_RUNTIME_ALERTS',count:alerts.length,totalReturned:(data.alerts ?? []).length,more:Boolean(data.nextPageToken),
      alerts:alerts.map(a=>({name:a.name,state:a.state,openTime:a.openTime,closeTime:a.closeTime}))}));
  }
} catch {console.error('CLOUD_MONITORING_EVIDENCE_FAILED');process.exitCode=1;}
