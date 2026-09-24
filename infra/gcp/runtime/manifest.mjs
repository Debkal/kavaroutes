import { isDeepStrictEqual } from 'node:util';

const entries = [
  ['database','keep','postgres-postgis','persistence','database-query','stop-host','local-compute'],
  ['jobs','keep','pg-boss-outbox','durable-execution','journal-recovery','stop-worker','local-compute'],
  ['realtime','keep','postgres-websocket','realtime','cursor-replay','stop-host','local-compute'],
  ['identity','keep','synthetic-verifier','api','tenant-denial','stop-host','none'],
  ['secrets','keep','private-file','platform','secret-file-tests','stop-host','none'],
  ['telemetry','keep','closed-local-output','platform','redaction-check','stop-host','none'],
  ['storage','disabled','none','platform','no-construction','none','none'],
  ['maps','optional','google-routes-and-static','routing','route-preview-tests','stop-api','metered-external'],
  ['push','disabled','none','communications','no-construction','none','none'],
  ['integrations','disabled','none','integrations','no-construction','none','none'],
  ['public-domain','retire','none','platform','loopback-only','none','none'],
];
function expected() {
  return { version: 1, environment: 'private-synthetic', adapters: entries.map(([id,decision,implementation,owner,verification,rollback,costClass]) =>
    ({ id,decision,implementation,owner,verification,rollback,costClass, configuration: 'locked-runtime', gate: 'CLD-006-local' })) };
}
// This manifest describes the local composition only, never completed GCP promotion.
export const runtimeManifest = Object.freeze({ ...expected(), adapters: Object.freeze(expected().adapters.map(Object.freeze)) });
export function validateManifest(value = runtimeManifest) {
  if (!isDeepStrictEqual(value, expected())) throw new Error('RUNTIME_ADAPTER_MANIFEST_INVALID');
  return value;
}
