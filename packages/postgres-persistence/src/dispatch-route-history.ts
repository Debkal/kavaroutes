import type {Pool} from 'pg';
import {withTenantTransaction} from './repositories.js';

/** Dispatch-safe event read: named actions and their times, never proof payloads,
 * signature strokes, raw notes, or GPS coordinates. GPS is read separately through
 * the existing tenant-scoped tracking endpoint. */
export function createDispatchRouteHistoryReader(pool:Pool){
  return (tenantId:string,serviceDate:string)=>withTenantTransaction(pool,tenantId,'kavaroutes_api',async db=>{
    if(!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate))throw new Error('INVALID_SERVICE_DATE');
    const rows=(await db.query(`WITH shifts AS (
      SELECT s.tenant_id,s.id AS shift_id,s.pinned_at,a.run_id
      FROM execution.shift_policy_snapshot s
      JOIN dispatch.assignment a ON a.tenant_id=s.tenant_id AND a.id=s.assignment_id
      JOIN dispatch.run r ON r.tenant_id=a.tenant_id AND r.id=a.run_id
      WHERE s.tenant_id=$1 AND r.service_date=$2::date
    ), events AS (
      SELECT s.shift_id,s.run_id,NULL::uuid AS trip_leg_id,'SHIFT_STARTED'::text AS kind,
        'SHIFT_STARTED'::text AS action,NULL::text AS outcome,NULL::text AS reason,
        s.pinned_at AS occurred_at,s.pinned_at AS recorded_at
      FROM shifts s
      UNION ALL
      SELECT s.shift_id,s.run_id,rl.trip_leg_id,'DRIVER_ACTION',a.command_reference,a.outcome,a.reason_code,
        a.captured_at,a.recorded_at
      FROM shifts s JOIN execution.driver_action_receipt a ON a.tenant_id=s.tenant_id AND a.shift_id=s.shift_id
      LEFT JOIN dispatch.run_leg rl ON rl.tenant_id=s.tenant_id AND rl.run_id=s.run_id AND rl.trip_leg_id=a.resource_reference
      UNION ALL
      SELECT s.shift_id,s.run_id,e.trip_leg_id,'SERVICE_PROOF',p.event,'RECORDED',NULL,
        p.recorded_at,p.recorded_at
      FROM shifts s JOIN execution.driver_service_proof p ON p.tenant_id=s.tenant_id AND p.shift_id=s.shift_id
      JOIN execution.leg_execution e ON e.tenant_id=p.tenant_id AND e.id=p.execution_id AND e.run_id=s.run_id
      UNION ALL
      SELECT s.shift_id,s.run_id,NULL,'TRACKING_ALERT',a.status,
        CASE WHEN a.contact_driver THEN 'CONTACT_DRIVER' ELSE 'MONITOR' END,a.reason,
        a.evaluated_at,a.evaluated_at
      FROM shifts s JOIN execution.driver_tracking_alert_event a ON a.tenant_id=s.tenant_id AND a.shift_id=s.shift_id
      UNION ALL
      SELECT s.shift_id,s.run_id,NULL,'SHIFT_CLOSURE',c.kind,c.return_result,c.reason_code,
        c.recorded_at,c.recorded_at
      FROM shifts s JOIN execution.driver_shift_closure c ON c.tenant_id=s.tenant_id AND c.shift_id=s.shift_id
    ) SELECT * FROM events ORDER BY recorded_at,shift_id,kind,action LIMIT 3001`,[tenantId,serviceDate])).rows;
    const tripClients=(await db.query(`SELECT DISTINCT t.id AS trip_id,f.id AS client_id,f.display_name AS client_label
      FROM dispatch.run r JOIN dispatch.run_leg rl ON rl.tenant_id=r.tenant_id AND rl.run_id=r.id
      JOIN intake.trip_leg l ON l.tenant_id=rl.tenant_id AND l.id=rl.trip_leg_id
      JOIN intake.trip_request t ON t.tenant_id=l.tenant_id AND t.id=l.trip_request_id
      JOIN intake.facility_trip_scope scope ON scope.tenant_id=t.tenant_id AND scope.trip_id=t.id
      JOIN intake.facility f ON f.tenant_id=scope.tenant_id AND f.id=scope.facility_id
      WHERE r.tenant_id=$1 AND r.service_date=$2::date ORDER BY t.id,f.id LIMIT 2001`,[tenantId,serviceDate])).rows;
    if(tripClients.length>2000)throw new Error('ROUTE_HISTORY_CLIENT_LIMIT');
    const events=rows.slice(0,3000).map(row=>({
      shiftReference:String(row.shift_id),runId:String(row.run_id),tripLegId:row.trip_leg_id===null?null:String(row.trip_leg_id),
      kind:String(row.kind),action:String(row.action),outcome:row.outcome===null?null:String(row.outcome),reason:row.reason===null?null:String(row.reason),
      occurredAt:new Date(row.occurred_at).toISOString(),recordedAt:new Date(row.recorded_at).toISOString(),
    }));
    return {serviceDate,truncated:rows.length>3000,events,
      tripClients:tripClients.map(row=>({tripId:String(row.trip_id),clientId:String(row.client_id),clientLabel:String(row.client_label)}))};
  });
}
