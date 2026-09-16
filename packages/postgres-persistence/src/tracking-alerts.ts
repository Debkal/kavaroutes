import type {Pool} from 'pg';
import {assessTrackingFreshness} from '@kavaroutes/platform-engine/domain';
import {withTenantTransaction} from './repositories.js';
/** Periodic server clock reconciliation: silence needs no incoming phone event. */
export async function reconcileTrackingAlerts(pool:Pool,tenantId:string,now=new Date()){
 return withTenantTransaction(pool,tenantId,'kavaroutes_outbox_consumer',async db=>{
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,17))',[tenantId]);
  await db.query('DELETE FROM execution.driver_synthetic_location WHERE tenant_id=$1 AND expires_at<=$2',[tenantId,now]);
  const shifts=(await db.query(`SELECT s.*,a.version AS alert_version,a.status AS alert_status,a.reason AS alert_reason,a.contact_driver AS alert_contact,
    (SELECT reason_code FROM execution.driver_shift_closure c WHERE c.tenant_id=s.tenant_id AND c.shift_id=s.id AND kind='EMERGENCY_STOP' ORDER BY aggregate_version DESC LIMIT 1) AS stop_reason
    FROM execution.shift_policy_snapshot s LEFT JOIN execution.driver_tracking_alert a ON a.tenant_id=s.tenant_id AND a.shift_id=s.id
    WHERE s.tenant_id=$1 AND (s.lifecycle<>'SHIFT_ENDED' OR a.status IS DISTINCT FROM 'SHIFT_ENDED') ORDER BY s.pinned_at,s.id LIMIT 501`,[tenantId])).rows;
  if(shifts.length>500)throw new Error('TRACKING_RECONCILIATION_CAPACITY_REVIEW_REQUIRED');
  let changed=0;
  for(const s of shifts){
   const t=assessTrackingFreshness({now:now.getTime(),startedAt:new Date(s.pinned_at).getTime(),lifecycle:s.lifecycle,collectionStopped:s.collection_stopped,lastCapturedAt:s.last_location_captured_at?new Date(s.last_location_captured_at).getTime():null,lastReceivedAt:s.last_location_received_at?new Date(s.last_location_received_at).getTime():null,stopReason:s.stop_reason});
   if(s.alert_status===t.status&&s.alert_reason===t.reason&&s.alert_contact===t.contactDriver)continue;
   const params=[tenantId,s.id,Number(s.alert_version??0)+1,t.status,t.reason,t.contactDriver,now,t.lastCapturedAt,t.lastReceivedAt];
   await db.query(`INSERT INTO execution.driver_tracking_alert VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(tenant_id,shift_id) DO UPDATE SET version=excluded.version,status=excluded.status,reason=excluded.reason,contact_driver=excluded.contact_driver,evaluated_at=excluded.evaluated_at,last_captured_at=excluded.last_captured_at,last_received_at=excluded.last_received_at`,params);
   await db.query('INSERT INTO execution.driver_tracking_alert_event VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',params);changed++;
  }
  return {changed,evaluated:shifts.length};
 },'serializable');
}
