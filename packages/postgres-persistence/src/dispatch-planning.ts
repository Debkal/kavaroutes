import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { PersistenceConflict } from "./repositories.js";

/**
 * Dispatch-authored planning. A dispatcher enters the run, its legs, and the pickup and
 * drop-off labels; the server persists real intake/dispatch/execution rows so the
 * assignment, driver itinerary, proof rules and receipts all run on the same authority as
 * any other service day. Nothing here is inferred from client fixtures.
 */
export interface DispatchPlanLegInput {
  readonly riderReference: string;
  readonly pickupLabel: string;
  readonly dropoffLabel: string;
  readonly localServiceTime: string;
  readonly resolvedServiceAt: Date;
  readonly resolvedUtcOffsetSeconds: number;
  readonly plannedStartAt: Date;
  readonly plannedEndAt: Date;
  readonly pickupRequired: boolean;
  readonly dropoffRequired: boolean;
  readonly mobilitySecurementRequired: boolean;
  readonly appointmentLengthMinutes: number;
  /** Records this outbound destination in the selected client's directory. Generated
   * return legs set this false so the home address is not counted as a destination. */
  readonly recordClientDropoff: boolean;
}

export interface DispatchPlanInput {
  readonly serviceDate: string;
  readonly serviceTimezone: string;
  readonly plannedStartAt: Date;
  readonly plannedEndAt: Date;
  readonly seatsRequired: number;
  readonly wheelchairSpacesRequired: number;
  readonly legs: readonly DispatchPlanLegInput[];
  /** The client this run is entered for. Null keeps the pre-client behaviour: a run
   * with no client still plans, it simply links no trip into a client scope. */
  readonly clientId: string | null;
}

export interface DispatchPlanReceipt {
  readonly runId: string;
  readonly version: number;
  readonly serviceDate: string;
  readonly legCount: number;
  readonly tripLegIds: readonly string[];
}

const proofRule = (leg: DispatchPlanLegInput) => ({
  pickupRequired: leg.pickupRequired, dropoffRequired: leg.dropoffRequired,
  mobilitySecurementRequired: leg.mobilitySecurementRequired,
  allowedRoles: ["RIDER", "RIDER_UNABLE_TO_SIGN"], unableReasons: ["PHYSICALLY_UNABLE"],
  noShowWaitMinutes: 15, noShowAllowed: false, noShowAuthorizationReference: null,
});
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export async function planDispatchRun(client: PoolClient, tenantId: string, input: DispatchPlanInput): Promise<DispatchPlanReceipt> {
  if (input.legs.length < 1) throw new PersistenceConflict("relationship", "a planned run needs at least one leg");
  const branch = (await client.query("SELECT id FROM platform.branch WHERE tenant_id=$1 ORDER BY id LIMIT 1", [tenantId])).rows[0];
  if (!branch) throw new PersistenceConflict("relationship", "a branch is required before a run can be planned");
  if (input.clientId) {
    const knownClient = (await client.query("SELECT id FROM intake.facility WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [tenantId, input.clientId])).rows[0];
    if (!knownClient) throw new PersistenceConflict("relationship", "the client record does not exist");
  }
  if (!input.clientId && input.legs.some(leg => leg.recordClientDropoff))
    throw new PersistenceConflict("relationship", "a client is required to record a drop-off address");
  const runId = randomUUID();
  await client.query(`INSERT INTO dispatch.run
    (tenant_id,id,branch_id,service_date,service_timezone,planned_start_at,planned_end_at,lifecycle_reference)
    VALUES($1,$2,$3,$4,$5,$6,$7,'planned')`,
  [tenantId, runId, branch.id, input.serviceDate, input.serviceTimezone, input.plannedStartAt, input.plannedEndAt]);
  await client.query(`INSERT INTO dispatch.run_service_requirements
    (tenant_id,run_id,version,seats_required,wheelchair_spaces_required,driver_qualifications,vehicle_qualifications)
    VALUES($1,$2,1,$3,$4,ARRAY[]::text[],ARRAY[]::text[])`,
  [tenantId, runId, input.seatsRequired, input.wheelchairSpacesRequired]);

  const tripLegIds: string[] = [];
  for (const [index, leg] of input.legs.entries()) {
    const ordinal = index + 1;
    const originId = randomUUID(), destinationId = randomUUID();
    await client.query("INSERT INTO intake.address(tenant_id,id,customer_label) VALUES($1,$2,$3),($1,$4,$5)",
      [tenantId, originId, leg.pickupLabel, destinationId, leg.dropoffLabel]);
    let rider = (await client.query("SELECT id FROM intake.rider WHERE tenant_id=$1 AND synthetic_reference=$2", [tenantId, leg.riderReference])).rows[0];
    if (!rider) {
      rider = (await client.query(`INSERT INTO intake.rider(tenant_id,id,synthetic_reference) VALUES($1,$2,$3)
        ON CONFLICT (tenant_id,synthetic_reference) DO UPDATE SET synthetic_reference=EXCLUDED.synthetic_reference
        RETURNING id`, [tenantId, randomUUID(), leg.riderReference])).rows[0];
    }
    if (!rider) throw new PersistenceConflict("relationship", "rider could not be recorded");
    const tripId = randomUUID(), tripLegId = randomUUID(), executionId = randomUUID();
    await client.query(`INSERT INTO intake.trip_request
      (tenant_id,id,rider_id,service_date,service_timezone,local_service_time,resolved_service_at,
       resolved_utc_offset_seconds,appointment_length_minutes,ambiguity_policy,ambiguity_policy_version,lifecycle_reference)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'reject','civil-v1','scheduled')`,
    [tenantId, tripId, rider.id, input.serviceDate, input.serviceTimezone, leg.localServiceTime,
      leg.resolvedServiceAt, leg.resolvedUtcOffsetSeconds, leg.appointmentLengthMinutes]);
    await client.query(`INSERT INTO intake.trip_leg
      (tenant_id,id,trip_request_id,ordinal,origin_address_id,destination_address_id,planned_start_at,planned_end_at)
      VALUES($1,$2,$3,1,$4,$5,$6,$7)`,
    [tenantId, tripLegId, tripId, originId, destinationId, leg.plannedStartAt, leg.plannedEndAt]);
    await client.query("INSERT INTO dispatch.run_leg(tenant_id,id,run_id,trip_leg_id,ordinal) VALUES($1,$2,$3,$4,$5)",
      [tenantId, randomUUID(), runId, tripLegId, ordinal]);
    if (input.clientId) await client.query("INSERT INTO intake.facility_trip_scope(tenant_id,facility_id,trip_id,active,version) VALUES($1,$2,$3,true,1)",
      [tenantId, input.clientId, tripId]);
    if (input.clientId && leg.recordClientDropoff) {
      const known = (await client.query(`SELECT d.ordinal FROM intake.client_dropoff d
        JOIN intake.address a ON a.tenant_id=d.tenant_id AND a.id=d.address_id
        WHERE d.tenant_id=$1 AND d.facility_id=$2 AND lower(btrim(a.customer_label))=lower(btrim($3))
        ORDER BY d.ordinal LIMIT 1`, [tenantId, input.clientId, leg.dropoffLabel])).rows[0];
      if (known) {
        await client.query(`UPDATE intake.client_dropoff SET usage_count=usage_count+1,last_used_at=$4
          WHERE tenant_id=$1 AND facility_id=$2 AND ordinal=$3`, [tenantId, input.clientId, known.ordinal, leg.plannedStartAt]);
      } else {
        const highest = (await client.query("SELECT coalesce(max(ordinal),0) AS ordinal FROM intake.client_dropoff WHERE tenant_id=$1 AND facility_id=$2", [tenantId, input.clientId])).rows[0];
        const directoryOrdinal = Number(highest?.ordinal ?? 0) + 1;
        if (directoryOrdinal > 100) throw new PersistenceConflict("relationship", "the client drop-off directory is full");
        const directoryAddressId = randomUUID();
        await client.query("INSERT INTO intake.address(tenant_id,id,customer_label) VALUES($1,$2,$3)", [tenantId, directoryAddressId, leg.dropoffLabel]);
        await client.query(`INSERT INTO intake.client_dropoff(tenant_id,facility_id,ordinal,address_id,usage_count,last_used_at)
          VALUES($1,$2,$3,$4,1,$5)`, [tenantId, input.clientId, directoryOrdinal, directoryAddressId, leg.plannedStartAt]);
      }
    }
    await client.query(`INSERT INTO execution.leg_execution(tenant_id,id,trip_leg_id,run_id,lifecycle_reference,occurred_at)
      VALUES($1,$2,$3,$4,'planned',now())`, [tenantId, executionId, tripLegId, runId]);
    const rule = proofRule(leg);
    await client.query(`INSERT INTO execution.driver_leg_proof_rule(tenant_id,execution_id,policy_version,policy_digest,rule)
      VALUES($1,$2,1,$3,$4::jsonb)`, [tenantId, executionId, digest(rule), JSON.stringify(rule)]);
    tripLegIds.push(tripLegId);
  }
  const run = (await client.query("SELECT aggregate_version FROM dispatch.run WHERE tenant_id=$1 AND id=$2", [tenantId, runId])).rows[0];
  return { runId, version: Number(run?.aggregate_version ?? 1), serviceDate: input.serviceDate, legCount: input.legs.length, tripLegIds };
}
