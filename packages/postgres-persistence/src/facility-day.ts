import type {Pool} from 'pg';
import {withTenantTransaction} from './repositories.js';
export type FacilityTripView={relatedTripReference:string;lifecycle:string;scheduledAt:string};
export function createFacilityDayReader(pool:Pool){
 return async(input:{tenantId:string;facilityId:string;serviceDate?:string;tripId?:string;after?:string;limit:number})=>withTenantTransaction(pool,input.tenantId,'kavaroutes_api',async client=>{
  const rows=(await client.query(`SELECT t.id,t.resolved_service_at,
   CASE WHEN t.lifecycle_reference='cancelled' THEN 'CANCELLED'
    WHEN leg.incident OR leg.total<>leg.unique_legs THEN 'NEEDS_COORDINATION'
    WHEN leg.total>0 AND leg.completed=leg.total THEN 'COMPLETED'
    WHEN leg.total>0 AND leg.no_show=leg.total THEN 'NO_SHOW'
    WHEN leg.started THEN 'IN_PROGRESS' ELSE 'SCHEDULED' END AS lifecycle
   FROM intake.facility_trip_scope scope JOIN intake.trip_request t ON t.tenant_id=scope.tenant_id AND t.id=scope.trip_id
   LEFT JOIN LATERAL(SELECT count(*) AS total,count(DISTINCT l.id) AS unique_legs,count(*) FILTER(WHERE e.lifecycle_reference='completed') AS completed,
    count(*) FILTER(WHERE e.lifecycle_reference='rider_no_show') AS no_show,
    bool_or(coalesce(c.incident_open,false)) AS incident,
    bool_or(e.lifecycle_reference NOT IN('planned','dispatched','cancelled')) AS started
    FROM intake.trip_leg l LEFT JOIN execution.leg_execution e ON e.tenant_id=l.tenant_id AND e.trip_leg_id=l.id
     AND EXISTS(SELECT 1 FROM dispatch.run_leg rl JOIN dispatch.run r ON r.tenant_id=rl.tenant_id AND r.id=rl.run_id WHERE rl.tenant_id=l.tenant_id AND rl.trip_leg_id=l.id AND rl.run_id=e.run_id AND r.lifecycle_reference<>'cancelled')
    LEFT JOIN execution.driver_leg_service_control c ON c.tenant_id=e.tenant_id AND c.execution_id=e.id
    WHERE l.tenant_id=t.tenant_id AND l.trip_request_id=t.id)leg ON true
   WHERE scope.tenant_id=$1 AND scope.facility_id=$2 AND scope.active
    AND ($3::date IS NULL OR t.service_date=$3) AND ($4::uuid IS NULL OR t.id=$4)
    AND ($5::uuid IS NULL OR t.id>$5) ORDER BY t.id LIMIT $6`,[input.tenantId,input.facilityId,input.serviceDate??null,input.tripId??null,input.after??null,input.limit+1])).rows;
  const more=rows.length>input.limit,items:FacilityTripView[]=rows.slice(0,input.limit).map(row=>({relatedTripReference:String(row.id),lifecycle:String(row.lifecycle),scheduledAt:new Date(row.resolved_service_at).toISOString()}));
  return {items,nextAfter:more?items.at(-1)!.relatedTripReference:null};
 },'serializable');
}
