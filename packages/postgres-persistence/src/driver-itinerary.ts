import type { Pool } from "pg";
import { withTenantTransaction } from "./repositories.js";
import type { JsonValue } from "./repositories.js";
export type StoredDriverServiceControl = { riderVerified: boolean;boardingSecure: boolean;safelyUnloaded: boolean;incidentOpen: boolean;
  pickupEvidenceId: string | null;dropoffEvidenceId: string | null;proofRule: { version: number;digest: string;rule: JsonValue } | null };

/** A subject-scoped read model. Never infer assignments from client fixtures. */
export interface StoredDriverItineraryLeg {
  readonly assignmentId: string;
  readonly assignmentVersion: number;
  readonly runId: string;
  readonly runVersion: number;
  readonly runLifecycle: string;
  readonly vehicleId: string | null;
  readonly vehicleLabel: string | null;
  readonly tripId: string;
  readonly tripLegId: string;
  readonly ordinal: number;
  readonly riderLabel: string;
  readonly pickupLabel: string;
  readonly dropoffLabel: string;
  readonly plannedStartAt: string;
  readonly plannedEndAt: string;
  readonly serviceTimezone: string;
  readonly execution?: { readonly executionId: string; readonly lifecycle: string; readonly version: number;readonly serviceControl?: StoredDriverServiceControl } | null;
}

export function createDriverItineraryReader(pool: Pool) {
  return async (tenantId: string, driverId: string, serviceDate: string): Promise<readonly StoredDriverItineraryLeg[]> => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)) throw new Error("INVALID_SERVICE_DATE");
    return withTenantTransaction(pool, tenantId, "kavaroutes_api", async (client) => {
      const result = await client.query(`SELECT
        a.id AS assignment_id, a.aggregate_version AS assignment_version,
        r.id AS run_id, r.aggregate_version AS run_version, r.lifecycle_reference AS run_lifecycle,
        a.vehicle_id, v.synthetic_reference AS vehicle_label,
        t.id AS trip_id, l.id AS trip_leg_id, rl.ordinal,
        rider.synthetic_reference AS rider_label, origin.customer_label AS pickup_label,
        destination.customer_label AS dropoff_label, l.planned_start_at, l.planned_end_at, r.service_timezone,
        execution.rows AS execution_rows
        FROM dispatch.assignment a
        JOIN fleet.driver d ON d.tenant_id=a.tenant_id AND d.id=a.driver_id
        JOIN dispatch.run r ON r.tenant_id=a.tenant_id AND r.id=a.run_id
        JOIN dispatch.run_leg rl ON rl.tenant_id=r.tenant_id AND rl.run_id=r.id
        JOIN intake.trip_leg l ON l.tenant_id=rl.tenant_id AND l.id=rl.trip_leg_id
        JOIN intake.trip_request t ON t.tenant_id=l.tenant_id AND t.id=l.trip_request_id
        JOIN intake.rider rider ON rider.tenant_id=t.tenant_id AND rider.id=t.rider_id
        JOIN intake.address origin ON origin.tenant_id=l.tenant_id AND origin.id=l.origin_address_id
        JOIN intake.address destination ON destination.tenant_id=l.tenant_id AND destination.id=l.destination_address_id
        LEFT JOIN fleet.vehicle v ON v.tenant_id=a.tenant_id AND v.id=a.vehicle_id
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(jsonb_build_object('executionId',e.id,'lifecycle',upper(e.lifecycle_reference),'version',e.aggregate_version,
            'serviceControl',jsonb_build_object('riderVerified',coalesce(c.rider_verified,false),'boardingSecure',coalesce(c.boarding_secure,false),
              'safelyUnloaded',coalesce(c.safely_unloaded,false),'incidentOpen',coalesce(c.incident_open,false),
              'proofRule',CASE WHEN pr.execution_id IS NULL THEN NULL ELSE jsonb_build_object('version',pr.policy_version,'digest',pr.policy_digest,'rule',pr.rule) END,
              'pickupEvidenceId',(SELECT p.evidence_id FROM execution.driver_service_proof p JOIN execution.shift_policy_snapshot ps ON ps.tenant_id=p.tenant_id AND ps.id=p.shift_id
                WHERE p.tenant_id=e.tenant_id AND p.execution_id=e.id AND p.event='PICKUP_ATTESTATION' AND ps.driver_id=$2 AND ps.assignment_id=a.id AND ps.lifecycle='ACTIVE'
                  AND NOT EXISTS(SELECT 1 FROM execution.driver_proof_supersession su WHERE su.tenant_id=p.tenant_id AND su.supersedes_evidence_id=p.evidence_id) LIMIT 1),
              'dropoffEvidenceId',(SELECT p.evidence_id FROM execution.driver_service_proof p JOIN execution.shift_policy_snapshot ps ON ps.tenant_id=p.tenant_id AND ps.id=p.shift_id
                WHERE p.tenant_id=e.tenant_id AND p.execution_id=e.id AND p.event='DROPOFF_ATTESTATION' AND ps.driver_id=$2 AND ps.assignment_id=a.id AND ps.lifecycle='ACTIVE'
                  AND NOT EXISTS(SELECT 1 FROM execution.driver_proof_supersession su WHERE su.tenant_id=p.tenant_id AND su.supersedes_evidence_id=p.evidence_id) LIMIT 1)))) AS rows
          FROM execution.leg_execution e LEFT JOIN execution.driver_leg_service_control c ON c.tenant_id=e.tenant_id AND c.execution_id=e.id
          LEFT JOIN execution.driver_leg_proof_rule pr ON pr.tenant_id=e.tenant_id AND pr.execution_id=e.id
          WHERE e.tenant_id=l.tenant_id AND e.trip_leg_id=l.id AND e.run_id=r.id
        ) execution ON true
        WHERE a.tenant_id=$1 AND a.driver_id=$2 AND r.service_date=$3 AND t.service_date=$3
          AND NOT EXISTS(SELECT 1 FROM dispatch.assignment_supersession su WHERE su.tenant_id=a.tenant_id AND su.prior_assignment_id=a.id)
          AND r.lifecycle_reference <> 'cancelled' AND t.lifecycle_reference <> 'cancelled'
        ORDER BY r.planned_start_at,r.id,rl.ordinal,a.id LIMIT 501`, [tenantId, driverId, serviceDate]);
      // Do not silently truncate a driver's day and present an incomplete itinerary.
      if (result.rows.length > 500) throw new Error("DRIVER_ITINERARY_LIMIT_EXCEEDED");
      return result.rows.map(row => {
        const executions = row.execution_rows as NonNullable<StoredDriverItineraryLeg["execution"]>[] | null;
        if (executions && executions.length !== 1) throw new Error("DRIVER_EXECUTION_AMBIGUOUS");
        return {
        assignmentId: String(row.assignment_id), assignmentVersion: Number(row.assignment_version),
        runId: String(row.run_id), runVersion: Number(row.run_version), runLifecycle: String(row.run_lifecycle),
        vehicleId: row.vehicle_id === null ? null : String(row.vehicle_id), vehicleLabel: row.vehicle_label === null ? null : String(row.vehicle_label),
        tripId: String(row.trip_id), tripLegId: String(row.trip_leg_id), ordinal: Number(row.ordinal),
        riderLabel: String(row.rider_label), pickupLabel: String(row.pickup_label), dropoffLabel: String(row.dropoff_label),
        plannedStartAt: (row.planned_start_at as Date).toISOString(), plannedEndAt: (row.planned_end_at as Date).toISOString(),
        serviceTimezone: String(row.service_timezone),
    execution: executions?.[0] ?? null,
        };
      });
    });
  };
}
