import type { Pool } from "pg";
import { withTenantTransaction, type JsonValue, type StoredDriverPrecheck } from "./repositories.js";

export function createDriverShiftReader(pool: Pool) {
  return async (tenantId: string, driverId: string, assignmentId: string) => withTenantTransaction(pool, tenantId, "kavaroutes_api", async db => {
    const result = await db.query(`SELECT s.id,s.shift_generation,s.aggregate_version,s.lifecycle,s.effective_policy,s.pinned_assignment_version,a.aggregate_version AS assignment_version,
      EXISTS(SELECT 1 FROM dispatch.assignment_supersession su WHERE su.tenant_id=a.tenant_id AND su.prior_assignment_id=a.id) AS superseded,
      (SELECT coalesce(max(sequence_number),0) FROM execution.driver_action_receipt ar WHERE ar.tenant_id=s.tenant_id AND ar.shift_id=s.id) AS last_action_sequence,
      p.vehicle_id,p.aggregate_version AS precheck_version,p.inspection_outcome,p.odometer_outcome,p.vehicle_state,p.odometer,p.fuel_level
      FROM execution.shift_policy_snapshot s
      JOIN dispatch.assignment a ON a.tenant_id=s.tenant_id AND a.id=s.assignment_id AND a.driver_id=s.driver_id
      LEFT JOIN execution.driver_precheck_decision p ON p.tenant_id=s.tenant_id AND p.shift_id=s.id
      WHERE s.tenant_id=$1 AND s.driver_id=$2 AND s.assignment_id=$3
      ORDER BY (s.lifecycle <> 'SHIFT_ENDED') DESC,s.pinned_at DESC,s.id DESC LIMIT 1`, [tenantId,driverId,assignmentId]);
    const row = result.rows[0]; if (!row) return null;
    const precheck: StoredDriverPrecheck | null = row.vehicle_id === null ? null : {
      vehicleId: String(row.vehicle_id), version: Number(row.precheck_version),
      inspectionOutcome: row.inspection_outcome, odometerOutcome: row.odometer_outcome, vehicleState: row.vehicle_state,
      odometer: row.odometer === null ? null : Number(row.odometer), fuelLevel: row.fuel_level,
    };
    return { shiftReference: String(row.id), shiftGeneration: String(row.shift_generation), resourceVersion: Number(row.aggregate_version),
      lifecycle: row.lifecycle === 'SHIFT_ENDED' ? 'SHIFT_ENDED' : row.superseded || row.pinned_assignment_version === null || Number(row.pinned_assignment_version) !== Number(row.assignment_version) ? 'INVALIDATE_REVIEW' : String(row.lifecycle),
      lastActionSequence: Number(row.last_action_sequence), effectivePolicy: row.effective_policy as JsonValue,
      precheck: precheck ? { shiftReference: String(row.id), vehicleId: precheck.vehicleId, resourceVersion: precheck.version,
        inspectionOutcome: precheck.inspectionOutcome, odometerOutcome: precheck.odometerOutcome, vehicleState: precheck.vehicleState,
        odometer: precheck.odometer, fuelLevel: precheck.fuelLevel } : null };
  });
}
