import {randomUUID} from "node:crypto";
import type {Pool,PoolClient} from "pg";
import {PersistenceConflict,withTenantTransaction} from "./repositories.js";
export type DispatchAssignmentInput={runId:string;expectedVersion:number;driverId:string;vehicleId:string;assignmentId:string};
export async function applyDispatchAssignment(client:PoolClient,tenantId:string,input:DispatchAssignmentInput) {
 const run=(await client.query("SELECT * FROM dispatch.run WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[tenantId,input.runId])).rows[0];
 if(!run)throw new PersistenceConflict("relationship","run hidden");
 if(Number(run.aggregate_version)!==input.expectedVersion)throw new PersistenceConflict("stale-version","run changed");
 if(!['draft','planned','scheduled','published'].includes(run.lifecycle_reference))throw new PersistenceConflict("relationship","run not assignable");
 const assignments=await client.query(`SELECT a.* FROM dispatch.assignment a WHERE a.tenant_id=$1 AND a.run_id=$2 AND a.released_at IS NULL AND NOT EXISTS(SELECT 1 FROM dispatch.assignment_supersession s WHERE s.tenant_id=a.tenant_id AND s.prior_assignment_id=a.id) FOR UPDATE`,[tenantId,input.runId]);
 if(assignments.rows.length>1)throw new PersistenceConflict("duplicate","ambiguous binding");
 const prior=assignments.rows[0];
 const driver=(await client.query("SELECT * FROM fleet.driver WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[tenantId,input.driverId])).rows[0];
 const vehicle=(await client.query("SELECT * FROM fleet.vehicle WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[tenantId,input.vehicleId])).rows[0];
 if(!driver || !vehicle)throw new PersistenceConflict("relationship","resources hidden");
 // Called inside a serializable mutation; configuration is administrator-owned.
 const rules=(await client.query("SELECT * FROM dispatch.run_service_requirements WHERE tenant_id=$1 AND run_id=$2",[tenantId,input.runId])).rows[0];
 const capacity=(await client.query("SELECT * FROM fleet.vehicle_capacity WHERE tenant_id=$1 AND vehicle_id=$2",[tenantId,input.vehicleId])).rows[0];
 if(!rules || !capacity || capacity.seats<rules.seats_required || capacity.wheelchair_spaces<rules.wheelchair_spaces_required)throw new PersistenceConflict("feasibility","resource feasibility required");
 for(const[kind,id,required]of [['driver',input.driverId,rules.driver_qualifications],['vehicle',input.vehicleId,rules.vehicle_qualifications]] as const){
  const qualified=(await client.query(`SELECT qualification_kind FROM fleet.qualification WHERE tenant_id=$1 AND ${kind}_id=$2 AND valid_during @> $3::date FOR SHARE`,[tenantId,id,run.service_date])).rows.map(r=>r.qualification_kind);
  if(!Array.isArray(required) || required.some((r:string)=>!qualified.includes(r)))throw new PersistenceConflict("qualification","qualifications required");
 }
 if((await client.query("SELECT 1 FROM execution.driver_precheck_decision WHERE tenant_id=$1 AND vehicle_id=$2 AND vehicle_state='BLOCKED_CRITICAL_DEFECT' UNION ALL SELECT 1 FROM execution.driver_postcheck_decision WHERE tenant_id=$1 AND vehicle_id=$2 AND vehicle_state='BLOCKED_CRITICAL_DEFECT' LIMIT 1",[tenantId,input.vehicleId])).rowCount)throw new PersistenceConflict("vehicle-blocked","critical vehicle defect");
 const executions=(await client.query("SELECT * FROM execution.leg_execution WHERE tenant_id=$1 AND run_id=$2 FOR UPDATE",[tenantId,input.runId])).rows;
 if(executions.some(e=>!['planned','dispatched'].includes(e.lifecycle_reference)))throw new PersistenceConflict("work-started","started execution requires recovery");
 if(prior && (await client.query("SELECT 1 FROM execution.shift_policy_snapshot WHERE tenant_id=$1 AND assignment_id=$2 AND lifecycle<>'SHIFT_ENDED' LIMIT 1",[tenantId,prior.id])).rowCount)throw new PersistenceConflict("shift-active","active shift must resolve before reassignment");
 const legs=(await client.query(`SELECT l.id,t.lifecycle_reference,l.planned_start_at,l.planned_end_at FROM dispatch.run_leg rl JOIN intake.trip_leg l ON l.tenant_id=rl.tenant_id AND l.id=rl.trip_leg_id JOIN intake.trip_request t ON t.tenant_id=l.tenant_id AND t.id=l.trip_request_id WHERE rl.tenant_id=$1 AND rl.run_id=$2 FOR UPDATE OF l,t`,[tenantId,input.runId])).rows;
 if(!legs.length || legs.some(l=>l.lifecycle_reference==='cancelled' || l.planned_start_at<run.planned_start_at || l.planned_end_at>run.planned_end_at))throw new PersistenceConflict("leg-window","leg disposition or time constraint");
 // Resource locks serialize all assignments; the exclusion constraint is a second guard.
 const overlap=await client.query(`SELECT 1 FROM dispatch.assignment a JOIN dispatch.run r ON r.tenant_id=a.tenant_id AND r.id=a.run_id WHERE a.tenant_id=$1 AND a.run_id<>$2 AND (a.driver_id=$3 OR a.vehicle_id=$4) AND r.lifecycle_reference NOT IN('cancelled','completed') AND tstzrange(r.planned_start_at,r.planned_end_at,'[)') && tstzrange($5,$6,'[)') AND a.released_at IS NULL AND NOT EXISTS(SELECT 1 FROM dispatch.assignment_supersession s WHERE s.tenant_id=a.tenant_id AND s.prior_assignment_id=a.id) LIMIT 1`,[tenantId,input.runId,input.driverId,input.vehicleId,run.planned_start_at,run.planned_end_at]);
 if(overlap.rowCount)throw new PersistenceConflict("resource-overlap","resources occupied");
 await client.query("UPDATE dispatch.resource_reservation SET cancelled_at=now() WHERE tenant_id=$1 AND run_id=$2 AND cancelled_at IS NULL",[tenantId,input.runId]);
 for(const[kind,id]of [['driver',input.driverId],['vehicle',input.vehicleId]])await client.query("INSERT INTO dispatch.resource_reservation(tenant_id,id,run_id,resource_kind,resource_id,occupied_during) VALUES($1,$2,$3,$4,$5,tstzrange($6,$7,'[)'))",[tenantId,randomUUID(),input.runId,kind,id,run.planned_start_at,run.planned_end_at]);
 await client.query("INSERT INTO dispatch.assignment(tenant_id,id,run_id,driver_id,vehicle_id,workforce_relationship) VALUES($1,$2,$3,$4,$5,$6)",[tenantId,input.assignmentId,input.runId,input.driverId,input.vehicleId,driver.workforce_relationship]);
 if(prior)await client.query("INSERT INTO dispatch.assignment_supersession(tenant_id,prior_assignment_id,replacement_assignment_id) VALUES($1,$2,$3)",[tenantId,prior.id,input.assignmentId]);
 for(const leg of legs){const es=executions.filter(e=>e.trip_leg_id===leg.id);if(es.length>1)throw new PersistenceConflict("duplicate","ambiguous execution");
  if(!es.length)await client.query("INSERT INTO execution.leg_execution(tenant_id,id,trip_leg_id,run_id,lifecycle_reference,occurred_at) VALUES($1,$2,$3,$4,'dispatched',now())",[tenantId,randomUUID(),leg.id,input.runId]);
  else if(es[0].lifecycle_reference==='planned')await client.query("UPDATE execution.leg_execution SET lifecycle_reference='dispatched',aggregate_version=aggregate_version+1,occurred_at=now() WHERE tenant_id=$1 AND id=$2",[tenantId,es[0].id]);
 }
 const version=Number(run.aggregate_version)+1;
 await client.query("UPDATE dispatch.run SET aggregate_version=$3,lifecycle_reference='published',updated_at=now() WHERE tenant_id=$1 AND id=$2",[tenantId,input.runId,version]);
 return {assignmentId:input.assignmentId,runId:input.runId,version,serviceDate:run.service_date instanceof Date?run.service_date.toISOString().slice(0,10):String(run.service_date),supersedes:prior?.id as string|undefined};
}

export function createDispatchBoardReader(pool:Pool){return async(tenantId:string,serviceDate:string)=>withTenantTransaction(pool,tenantId,'kavaroutes_api',async db=>{
 if(!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate))throw new Error('INVALID_SERVICE_DATE');
 const runs=(await db.query(`SELECT r.id,r.aggregate_version,r.lifecycle_reference,r.planned_start_at,r.planned_end_at,r.service_timezone,
  a.id AS assignment_id,a.driver_id,a.vehicle_id FROM dispatch.run r LEFT JOIN dispatch.assignment a ON a.tenant_id=r.tenant_id AND a.run_id=r.id AND a.released_at IS NULL AND NOT EXISTS(SELECT 1 FROM dispatch.assignment_supersession s WHERE s.tenant_id=a.tenant_id AND s.prior_assignment_id=a.id)
  WHERE r.tenant_id=$1 AND r.service_date=$2 AND r.lifecycle_reference<>'cancelled' ORDER BY r.planned_start_at,r.id LIMIT 501`,[tenantId,serviceDate])).rows;
 if(runs.length>500 || new Set(runs.map(r=>r.id)).size!==runs.length)throw new Error('DISPATCH_BOARD_LIMIT_OR_AMBIGUITY');
 const legs=(await db.query(`SELECT rl.run_id,l.id,t.id AS trip_id,rl.ordinal,rider.synthetic_reference AS rider_label,o.customer_label AS pickup,d.customer_label AS dropoff,l.planned_start_at,l.planned_end_at,t.lifecycle_reference AS trip_state,e.id AS execution_id,e.lifecycle_reference AS execution_state,e.aggregate_version AS execution_version
 FROM dispatch.run_leg rl JOIN dispatch.run r ON r.tenant_id=rl.tenant_id AND r.id=rl.run_id JOIN intake.trip_leg l ON l.tenant_id=rl.tenant_id AND l.id=rl.trip_leg_id JOIN intake.trip_request t ON t.tenant_id=l.tenant_id AND t.id=l.trip_request_id JOIN intake.rider rider ON rider.tenant_id=t.tenant_id AND rider.id=t.rider_id JOIN intake.address o ON o.tenant_id=l.tenant_id AND o.id=l.origin_address_id JOIN intake.address d ON d.tenant_id=l.tenant_id AND d.id=l.destination_address_id LEFT JOIN execution.leg_execution e ON e.tenant_id=l.tenant_id AND e.trip_leg_id=l.id AND e.run_id=r.id WHERE rl.tenant_id=$1 AND r.service_date=$2 AND r.lifecycle_reference<>'cancelled' ORDER BY r.id,rl.ordinal LIMIT 2001`,[tenantId,serviceDate])).rows;
 if(legs.length>2000 || new Set(legs.map(l=>`${l.run_id}:${l.id}`)).size!==legs.length)throw new Error('DISPATCH_BOARD_LIMIT_OR_AMBIGUITY');
 const drivers=(await db.query("SELECT id,synthetic_reference FROM fleet.driver WHERE tenant_id=$1 ORDER BY id LIMIT 501",[tenantId])).rows;
 const vehicles=(await db.query("SELECT id,synthetic_reference FROM fleet.vehicle WHERE tenant_id=$1 ORDER BY id LIMIT 501",[tenantId])).rows;
 if(drivers.length>500 || vehicles.length>500)throw new Error('DISPATCH_FLEET_LIMIT');
 return {serviceDate,runs:runs.map(r=>({runId:String(r.id),version:Number(r.aggregate_version),lifecycle:String(r.lifecycle_reference),plannedStartAt:r.planned_start_at.toISOString(),plannedEndAt:r.planned_end_at.toISOString(),serviceTimezone:String(r.service_timezone),assignmentId:r.assignment_id??null,driverId:r.driver_id??null,vehicleId:r.vehicle_id??null})),
  legs:legs.map(l=>({runId:String(l.run_id),tripLegId:String(l.id),tripId:String(l.trip_id),ordinal:Number(l.ordinal),riderLabel:String(l.rider_label),pickupLabel:String(l.pickup),dropoffLabel:String(l.dropoff),plannedStartAt:l.planned_start_at.toISOString(),plannedEndAt:l.planned_end_at.toISOString(),tripState:String(l.trip_state),executionId:l.execution_id??null,lifecycle:l.execution_state??'planned',version:l.execution_version===null?0:Number(l.execution_version)})),
  drivers:drivers.map(d=>({id:String(d.id),label:String(d.synthetic_reference)})),vehicles:vehicles.map(v=>({id:String(v.id),label:String(v.synthetic_reference)}))};
},'serializable');}

/** Removing a driver from a route. Nothing replaces the assignment, so the historical
 * binding is marked released and the run returns to planned with its legs un-started.
 * The same guards as assignment apply: recorded work and an open driver shift both stop
 * the release, because dispatch must not erase state a driver has already produced. */
export interface DispatchReleaseInput { readonly runId: string; readonly expectedVersion: number; readonly reason: "DISPATCH_REMOVED" }
export interface DispatchReleaseReceipt { readonly runId: string; readonly version: number; readonly serviceDate: string; readonly releasedAssignmentId: string }
export async function releaseDispatchAssignment(client: PoolClient, tenantId: string, input: DispatchReleaseInput): Promise<DispatchReleaseReceipt> {
  const run = (await client.query(`SELECT id,service_date,lifecycle_reference,aggregate_version FROM dispatch.run
    WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [tenantId, input.runId])).rows[0];
  if (!run) throw new PersistenceConflict("relationship", "run hidden");
  if (Number(run.aggregate_version) !== input.expectedVersion) throw new PersistenceConflict("stale-version", "run changed");
  if (!["draft","planned","scheduled","published"].includes(String(run.lifecycle_reference))) throw new PersistenceConflict("relationship", "run not releasable");
  const current = (await client.query(`SELECT a.* FROM dispatch.assignment a WHERE a.tenant_id=$1 AND a.run_id=$2 AND a.released_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM dispatch.assignment_supersession s WHERE s.tenant_id=a.tenant_id AND s.prior_assignment_id=a.id) FOR UPDATE`,
  [tenantId, input.runId])).rows;
  if (!current.length) throw new PersistenceConflict("relationship", "run has no current assignment");
  if (current.length > 1) throw new PersistenceConflict("duplicate", "ambiguous binding");
  const prior = current[0]!;
  const executions = (await client.query("SELECT * FROM execution.leg_execution WHERE tenant_id=$1 AND run_id=$2 FOR UPDATE", [tenantId, input.runId])).rows;
  if (executions.some(row => !["planned","dispatched"].includes(String(row.lifecycle_reference)))) throw new PersistenceConflict("work-started", "started execution requires recovery");
  if ((await client.query("SELECT 1 FROM execution.shift_policy_snapshot WHERE tenant_id=$1 AND assignment_id=$2 AND lifecycle<>'SHIFT_ENDED' LIMIT 1",
    [tenantId, prior.id])).rowCount) throw new PersistenceConflict("shift-active", "an open shift must be resolved before the driver is removed");
  await client.query("UPDATE dispatch.assignment SET released_at=now(), release_reason=$3 WHERE tenant_id=$1 AND id=$2", [tenantId, prior.id, input.reason]);
  await client.query("UPDATE dispatch.resource_reservation SET cancelled_at=now() WHERE tenant_id=$1 AND run_id=$2 AND cancelled_at IS NULL", [tenantId, input.runId]);
  await client.query("UPDATE dispatch.run SET lifecycle_reference='planned', aggregate_version=aggregate_version+1 WHERE tenant_id=$1 AND id=$2", [tenantId, input.runId]);
  for (const execution of executions) {
    if (String(execution.lifecycle_reference) !== "dispatched") continue;
    await client.query("UPDATE execution.leg_execution SET lifecycle_reference='planned', aggregate_version=aggregate_version+1, occurred_at=now() WHERE tenant_id=$1 AND id=$2",
      [tenantId, execution.id]);
  }
  const updated = (await client.query("SELECT aggregate_version,service_date FROM dispatch.run WHERE tenant_id=$1 AND id=$2", [tenantId, input.runId])).rows[0]!;
  return {runId: input.runId, version: Number(updated.aggregate_version),
   serviceDate: updated.service_date instanceof Date ? updated.service_date.toISOString().slice(0,10) : String(updated.service_date),
   releasedAssignmentId: String(prior.id)};
}
