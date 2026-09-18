import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { assessTrackingFreshness } from '@kavaroutes/platform-engine/domain';
import { PersistenceConflict, withTenantTransaction } from './repositories.js';

/**
 * Device positioning for the live driver map. A sample is a real fix reported by the
 * driver's browser or phone (never a fixture), so the writer keeps three things that
 * must agree: the append-only breadcrumb (the retraceable trace), the current position
 * (what the map shows now) and the shift's freshness stamps (what the tracking alert
 * machinery assesses). The batch receipt binds all three to one shift and makes a
 * repeated submit idempotent.
 */
export interface DeviceLocationSample {
  readonly sampleId: string;
  readonly sequence: number;
  readonly capturedAt: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly accuracyMeters?: number | null;
}
export interface DeviceLocationBatchInput {
  readonly shiftId: string;
  readonly generation: string;
  readonly deviceId: string;
  readonly batchReference: string;
  readonly samples: readonly DeviceLocationSample[];
}
export interface DeviceLocationItem { readonly sampleId: string; readonly outcome: 'APPLIED' | 'REPLAYED' | 'REJECTED'; readonly code: string }

const retentionPolicyVersion = 'raw-location-30d-v1';
const retentionMilliseconds = 2_592_000_000;
const fingerprint = (samples: readonly DeviceLocationSample[]) =>
  createHash('sha256').update(JSON.stringify(samples.map(sample => [sample.sampleId, sample.sequence, sample.capturedAt, sample.latitude, sample.longitude, sample.accuracyMeters ?? null]))).digest('hex');

export async function recordDeviceLocations(db: PoolClient, tenantId: string, input: DeviceLocationBatchInput): Promise<readonly DeviceLocationItem[]> {
  const shift = (await db.query('SELECT driver_id,lifecycle,shift_generation,collection_stopped,pinned_at FROM execution.shift_policy_snapshot WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [tenantId, input.shiftId])).rows[0];
  if (!shift || shift.lifecycle !== 'ACTIVE' || shift.shift_generation !== input.generation) throw new PersistenceConflict('relationship', 'tracking generation closed');
  // A stopped shift keeps its trace but accepts nothing new: the emergency stop is the
  // point at which collection ended.
  if (shift.collection_stopped) throw new PersistenceConflict('relationship', 'location collection stopped');
  const now = Date.now();
  const hash = fingerprint(input.samples);
  const receipt = (await db.query(`SELECT id,sample_count FROM realtime.location_batch_receipt WHERE tenant_id=$1 AND device_id=$2 AND request_fingerprint=$3`, [tenantId, input.deviceId, hash])).rows[0];
  if (receipt) {
    if (Number(receipt.sample_count) !== input.samples.length) throw new PersistenceConflict('idempotency-mismatch', 'location batch identity changed');
    return input.samples.map(sample => ({ sampleId: sample.sampleId, outcome: 'REPLAYED' as const, code: 'LOCATION_SAMPLE_SAVED' }));
  }
  const items: DeviceLocationItem[] = [];
  const accepted: DeviceLocationSample[] = [];
  for (const sample of input.samples) {
    const captured = Date.parse(sample.capturedAt);
    const withinClock = Number.isFinite(captured) && captured >= new Date(shift.pinned_at).getTime() - 5 * 60_000 && captured <= now + 30_000 && now - captured < 30 * 60_000;
    if (!withinClock || sample.latitude < -90 || sample.latitude > 90 || sample.longitude < -180 || sample.longitude > 180) {
      items.push({ sampleId: sample.sampleId, outcome: 'REJECTED', code: 'SAMPLE_OUTSIDE_RETENTION' });
      continue;
    }
    accepted.push(sample);
    items.push({ sampleId: sample.sampleId, outcome: 'APPLIED', code: 'LOCATION_SAMPLE_SAVED' });
  }
  if (!accepted.length) return items;
  await db.query(`INSERT INTO realtime.location_batch_receipt(tenant_id,id,device_id,request_fingerprint,sample_count,shift_id) VALUES($1,$2,$3,$4,$5,$6)`,
    [tenantId, input.batchReference, input.deviceId, hash, accepted.length, input.shiftId]);
  for (const [index, sample] of accepted.entries()) {
    const capturedAt = new Date(sample.capturedAt);
    await db.query(`INSERT INTO realtime.location_breadcrumb
      (tenant_id,id,batch_id,sample_index,subject_kind,subject_id,device_id,stream_epoch,sequence_number,captured_at,retention_due_at,retention_policy_version,legal_hold,position,accuracy_meters)
      VALUES($1,$2,$3,$4,'driver',$5,$6,0,$7,$8,$9,$10,false,ST_SetSRID(ST_MakePoint($11,$12),4326)::geography,$13)`,
    [tenantId, sample.sampleId, input.batchReference, index, shift.driver_id, input.deviceId, sample.sequence, capturedAt,
      new Date(capturedAt.getTime() + retentionMilliseconds), retentionPolicyVersion, sample.longitude, sample.latitude, sample.accuracyMeters ?? null]);
  }
  // The current position is the newest accepted fix; the breadcrumb remains the history.
  const newest = accepted.reduce((latest, sample) => Date.parse(sample.capturedAt) > Date.parse(latest.capturedAt) ? sample : latest, accepted[0]!);
  await db.query(`SELECT realtime.advance_current_position($1,'driver',$2,$3,0,$4,$5,$6,$7,$8,$9)`,
    [tenantId, shift.driver_id, input.deviceId, newest.sequence, newest.capturedAt, new Date(now),
      newest.longitude, newest.latitude, input.batchReference]);
  await db.query(`UPDATE execution.shift_policy_snapshot SET last_location_captured_at=$3,last_location_received_at=now()
    WHERE tenant_id=$1 AND id=$2 AND (last_location_captured_at IS NULL OR last_location_captured_at<$3::timestamptz)`,
  [tenantId, input.shiftId, newest.capturedAt]);
  return items;
}

export interface ShiftTrackPoint { readonly latitude: number; readonly longitude: number; readonly accuracyMeters: number | null; readonly capturedAt: string }
export interface ShiftTrack {
  readonly shiftReference: string; readonly driverId: string; readonly driverLabel: string; readonly serviceDate: string;
  readonly lifecycle: string; readonly status: string; readonly reason: string; readonly contactDriver: boolean;
  readonly silentSeconds: number; readonly lastReceivedAt: string | null; readonly lastCapturedAt: string | null;
  readonly staleAfterSeconds: number; readonly retryAfterSeconds: number;
  readonly position: ShiftTrackPoint | null; readonly trace: readonly ShiftTrackPoint[];
}

/** What Dispatch reads: one row per shift on the service day, with the live position, the
 * bounded trace for a retraceable path, and the silence a lost signal has produced. */
export function createDispatchTrackingReader(pool: Pool) {
  return (tenantId: string, serviceDate: string): Promise<{ readonly serviceDate: string; readonly shifts: readonly ShiftTrack[] }> => withTenantTransaction(pool, tenantId, 'kavaroutes_api', async db => {
    const rows = (await db.query(`SELECT s.id,s.driver_id,d.synthetic_reference AS driver_label,s.lifecycle,s.collection_stopped,s.pinned_at,
        s.last_location_captured_at,s.last_location_received_at,
        alert.status AS alert_status,alert.reason AS alert_reason,alert.contact_driver AS alert_contact,
        (SELECT reason_code FROM execution.driver_shift_closure c WHERE c.tenant_id=s.tenant_id AND c.shift_id=s.id AND c.kind='EMERGENCY_STOP' ORDER BY c.aggregate_version DESC LIMIT 1) AS stop_reason
      FROM execution.shift_policy_snapshot s
      JOIN dispatch.assignment a ON a.tenant_id=s.tenant_id AND a.id=s.assignment_id
      JOIN dispatch.run r ON r.tenant_id=a.tenant_id AND r.id=a.run_id
      JOIN fleet.driver d ON d.tenant_id=s.tenant_id AND d.id=s.driver_id
      LEFT JOIN execution.driver_tracking_alert alert ON alert.tenant_id=s.tenant_id AND alert.shift_id=s.id
      WHERE s.tenant_id=$1 AND r.service_date=$2::date ORDER BY s.pinned_at,s.id LIMIT 200`, [tenantId, serviceDate])).rows;
    const tracks: ShiftTrack[] = [];
    for (const row of rows) {
      // The shift's own breadcrumbs are both the trace and the current position, so the
      // map and the retrace cannot disagree. The newest 500 are kept (oldest first), and
      // the newest of those is what the marker shows.
      const trace = (await db.query(`SELECT ST_Y(b.position::geometry) AS latitude,ST_X(b.position::geometry) AS longitude,b.accuracy_meters,b.captured_at
        FROM realtime.location_breadcrumb b JOIN realtime.location_batch_receipt r ON r.tenant_id=b.tenant_id AND r.id=b.batch_id
        WHERE b.tenant_id=$1 AND r.shift_id=$2 ORDER BY b.captured_at DESC LIMIT 500`, [tenantId, row.id])).rows.reverse();
      const position = trace[trace.length - 1];
      const evaluation = assessTrackingFreshness({ now: Date.now(), startedAt: new Date(row.pinned_at).getTime(), lifecycle: String(row.lifecycle),
        collectionStopped: Boolean(row.collection_stopped), lastCapturedAt: row.last_location_captured_at ? new Date(row.last_location_captured_at).getTime() : null,
        lastReceivedAt: row.last_location_received_at ? new Date(row.last_location_received_at).getTime() : null,
        stopReason: row.stop_reason ?? null });
      const silentFrom = row.last_location_received_at ? new Date(row.last_location_received_at).getTime() : new Date(row.pinned_at).getTime();
      const point = (value: { latitude: unknown; longitude: unknown; accuracy_meters?: unknown; captured_at: unknown }): ShiftTrackPoint => ({
        latitude: Number(value.latitude), longitude: Number(value.longitude),
        accuracyMeters: value.accuracy_meters === undefined || value.accuracy_meters === null ? null : Number(value.accuracy_meters),
        capturedAt: new Date(value.captured_at as Date).toISOString() });
      tracks.push({ shiftReference: String(row.id), driverId: String(row.driver_id), driverLabel: String(row.driver_label),
        serviceDate, lifecycle: String(row.lifecycle), status: String(row.alert_status ?? evaluation.status),
        reason: String(row.alert_reason ?? evaluation.reason), contactDriver: Boolean(row.alert_contact ?? evaluation.contactDriver),
        silentSeconds: evaluation.status === 'UPDATES_CURRENT' || evaluation.status === 'SHIFT_ENDED' ? 0 : Math.max(0, Math.round((Date.now() - silentFrom) / 1000)),
        lastReceivedAt: evaluation.lastReceivedAt, lastCapturedAt: evaluation.lastCapturedAt, staleAfterSeconds: evaluation.staleAfterSeconds, retryAfterSeconds: 30,
        position: position ? point(position) : null, trace: trace.map(point) });
    }
    return { serviceDate, shifts: tracks };
  });
}
