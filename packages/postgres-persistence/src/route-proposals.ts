import type {Pool,PoolClient} from 'pg';
import {validateFutureRoute,type RouteNode,type RouteFeasibility} from '@kavaroutes/platform-engine/domain';
import {PersistenceConflict,withTenantTransaction} from './repositories.js';

export type RouteProposalInput={proposalId:string;shiftId:string;driverId:string;actorId:string;shiftGeneration:string;policyDigest:string;expectedRunVersion:number;order:readonly string[];selfApproveCapability:boolean};
type Context={shift:Record<string,any>;run:Record<string,any>;facts:Record<string,any>;nodes:RouteNode[];rules:RouteFeasibility};
const conflict=(message:string):never=>{throw new PersistenceConflict('relationship',message);};
async function context(db:PoolClient,tenantId:string,shiftId:string):Promise<Context>{
 const shift=(await db.query(`SELECT s.*,a.run_id,a.driver_id AS assigned_driver,a.vehicle_id,a.aggregate_version AS assignment_version
  FROM execution.shift_policy_snapshot s JOIN dispatch.assignment a ON a.tenant_id=s.tenant_id AND a.id=s.assignment_id
  WHERE s.tenant_id=$1 AND s.id=$2 AND NOT EXISTS(SELECT 1 FROM dispatch.assignment_supersession su WHERE su.tenant_id=a.tenant_id AND su.prior_assignment_id=a.id) FOR UPDATE OF s,a`,[tenantId,shiftId])).rows[0];
 if(!shift||shift.lifecycle!=='ACTIVE'||shift.pinned_assignment_version===null||Number(shift.pinned_assignment_version)!==Number(shift.assignment_version)||shift.driver_id!==shift.assigned_driver)conflict('route shift unavailable');
 const run=(await db.query('SELECT * FROM dispatch.run WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[tenantId,shift.run_id])).rows[0];
 if(!run||!['scheduled','published','in_progress'].includes(run.lifecycle_reference))conflict('route run unavailable');
 const facts=(await db.query('SELECT * FROM dispatch.route_planning_facts WHERE tenant_id=$1 AND run_id=$2',[tenantId,run.id])).rows[0];
 if(!facts||!Array.isArray(facts.nodes)||!facts.feasibility)conflict('route planning facts required');
 const legs=(await db.query(`SELECT l.id,e.lifecycle_reference FROM dispatch.run_leg rl JOIN intake.trip_leg l ON l.tenant_id=rl.tenant_id AND l.id=rl.trip_leg_id
 JOIN intake.trip_request t ON t.tenant_id=l.tenant_id AND t.id=l.trip_request_id
 LEFT JOIN execution.leg_execution e ON e.tenant_id=l.tenant_id AND e.trip_leg_id=l.id AND e.run_id=rl.run_id
 WHERE rl.tenant_id=$1 AND rl.run_id=$2 AND t.lifecycle_reference<>'cancelled' FOR UPDATE OF rl,l,t`,[tenantId,run.id])).rows;
 if(!legs.length||new Set(legs.map(l=>l.id)).size!==legs.length)conflict('route execution ambiguity');
 if(legs.some(l=>!l.lifecycle_reference))conflict('explicit execution required');
 // Actual started/terminal execution is authoritative, not planning-facts lock flags.
 const nodes=(facts.nodes as RouteNode[]).map(n=>{
  const leg=n.legId?legs.find(l=>l.id===n.legId):null;
  if(n.legId&&!leg)conflict('route ownership changed');
  return {...n,locked:n.locked||!!(leg&&!['planned','dispatched'].includes(leg.lifecycle_reference))};
 });
 const capacity=(await db.query('SELECT * FROM fleet.vehicle_capacity WHERE tenant_id=$1 AND vehicle_id=$2',[tenantId,shift.vehicle_id])).rows[0];
 const requirements=(await db.query('SELECT * FROM dispatch.run_service_requirements WHERE tenant_id=$1 AND run_id=$2',[tenantId,run.id])).rows[0];
 if(!capacity||!requirements)conflict('route resource constraints required');
 for(const[kind,id,required]of [['driver',shift.driver_id,requirements.driver_qualifications],['vehicle',shift.vehicle_id,requirements.vehicle_qualifications]] as const){
  const present=(await db.query(`SELECT qualification_kind FROM fleet.qualification WHERE tenant_id=$1 AND ${kind}_id=$2 AND valid_during @> $3::date`,[tenantId,id,run.service_date])).rows.map(r=>r.qualification_kind);
  if(!Array.isArray(required)||required.some((q:string)=>!present.includes(q)))conflict('route qualification invalid');
 }
 if((await db.query("SELECT 1 FROM execution.driver_precheck_decision WHERE tenant_id=$1 AND vehicle_id=$2 AND vehicle_state='BLOCKED_CRITICAL_DEFECT' UNION ALL SELECT 1 FROM execution.driver_postcheck_decision WHERE tenant_id=$1 AND vehicle_id=$2 AND vehicle_state='BLOCKED_CRITICAL_DEFECT' LIMIT 1",[tenantId,shift.vehicle_id])).rowCount)conflict('critical vehicle defect');
 const rules={...facts.feasibility,seats:capacity.seats,wheelchairSpaces:capacity.wheelchair_spaces} as RouteFeasibility;
 if(!Array.isArray(rules.legs)||rules.legs.length!==legs.length||rules.legs.some(l=>!legs.some(actual=>actual.id===l.legId)))conflict('route leg constraints incomplete');
 const revision=(await db.query('SELECT node_order FROM dispatch.route_revision WHERE tenant_id=$1 AND run_id=$2 ORDER BY run_version DESC LIMIT 1',[tenantId,run.id])).rows[0];
 const current=revision?(revision.node_order as string[]).map(id=>nodes.find(n=>n.id===id)!):nodes;
 if(current.length!==nodes.length||current.some(n=>!n))conflict('route facts revision mismatch');
 return {shift,run,facts,nodes:current,rules};
}
async function accept(db:PoolClient,tenantId:string,c:Context,proposalId:string,order:readonly string[],actorId:string,self:boolean){
 const schedule=validateFutureRoute(c.nodes,order,c.rules),version=Number(c.run.aggregate_version)+1;
 await db.query('INSERT INTO dispatch.route_revision(tenant_id,run_id,run_version,proposal_id,node_order,schedule) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)',[tenantId,c.run.id,version,proposalId,JSON.stringify(order),JSON.stringify(schedule)]);
 await db.query('UPDATE dispatch.run SET aggregate_version=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2',[tenantId,c.run.id,version]);
 // Leg ordering is the pickup order; full P/D/multi-load order lives in immutable revision.
 const pickups=order.map(id=>c.nodes.find(n=>n.id===id)!).filter(n=>n.kind==='PICKUP');
 await db.query('UPDATE dispatch.run_leg SET ordinal=ordinal+10000 WHERE tenant_id=$1 AND run_id=$2',[tenantId,c.run.id]);
 for(let i=0;i<pickups.length;i++)await db.query('UPDATE dispatch.run_leg SET ordinal=$4 WHERE tenant_id=$1 AND run_id=$2 AND trip_leg_id=$3',[tenantId,c.run.id,pickups[i]!.legId,i+1]);
 await db.query("INSERT INTO dispatch.route_proposal_decision(tenant_id,proposal_id,decision,actor_id,reason_code,committed_run_version) VALUES($1,$2,'APPROVED',$3,$4,$5)",[tenantId,proposalId,actorId,self?'VALIDATED_SELF_APPROVAL':'DISPATCH_APPROVED',version]);
 return {proposalId,runId:String(c.run.id),runVersion:version,state:'APPROVED' as const};
}
/** Invoked only within the authenticated service's serializable idempotent transaction. */
export async function submitRouteProposal(db:PoolClient,tenantId:string,input:RouteProposalInput){
 const c=await context(db,tenantId,input.shiftId);
 if(c.shift.driver_id!==input.driverId||c.shift.shift_generation!==input.shiftGeneration||c.shift.policy_digest!==input.policyDigest)conflict('route shift binding changed');
 if(Number(c.run.aggregate_version)!==input.expectedRunVersion)throw new PersistenceConflict('stale-version','route changed');
 const mode=c.shift.effective_policy?.routeChange?.mode;
 if(!['AUTHORIZED_SELF_APPROVE','DISPATCH_APPROVAL_REQUIRED'].includes(mode))conflict('route changes disabled');
 if(mode==='AUTHORIZED_SELF_APPROVE'&&!input.selfApproveCapability)conflict('self approval capability required');
 validateFutureRoute(c.nodes,input.order,c.rules);
 await db.query(`INSERT INTO dispatch.route_proposal(tenant_id,id,shift_id,assignment_id,run_id,proposer_id,shift_generation,policy_digest,run_version,facts_version,proposed_order,approval_mode,expires_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,now()+interval '30 minutes')`,[tenantId,input.proposalId,input.shiftId,c.shift.assignment_id,c.run.id,input.actorId,input.shiftGeneration,input.policyDigest,input.expectedRunVersion,c.facts.version,JSON.stringify(input.order),mode]);
 if(mode==='AUTHORIZED_SELF_APPROVE')return accept(db,tenantId,c,input.proposalId,input.order,input.actorId,true);
 return {proposalId:input.proposalId,runId:String(c.run.id),runVersion:Number(c.run.aggregate_version),state:'PENDING_DISPATCH_APPROVAL' as const};
}
export async function decideRouteProposal(db:PoolClient,tenantId:string,input:{proposalId:string;actorId:string;decision:'APPROVED'|'REJECTED';expectedRunVersion:number}){
 const proposal=(await db.query('SELECT *,expires_at<=now() AS expired FROM dispatch.route_proposal WHERE tenant_id=$1 AND id=$2',[tenantId,input.proposalId])).rows[0];
 if(!proposal)conflict('route proposal hidden');
 const c=await context(db,tenantId,proposal.shift_id);
 if((await db.query('SELECT 1 FROM dispatch.route_proposal_decision WHERE tenant_id=$1 AND proposal_id=$2',[tenantId,input.proposalId])).rowCount)throw new PersistenceConflict('duplicate','proposal already decided');
 if(proposal.approval_mode!=='DISPATCH_APPROVAL_REQUIRED')conflict('proposal decision unavailable');
 const stale=Number(proposal.run_version)!==Number(c.run.aggregate_version)||Number(c.facts.version)!==Number(proposal.facts_version)||proposal.policy_digest!==c.shift.policy_digest||input.expectedRunVersion!==Number(c.run.aggregate_version);
 const state=proposal.expired?'EXPIRED':stale?'CONFLICT':input.decision;
 if(state==='APPROVED')return accept(db,tenantId,c,input.proposalId,proposal.proposed_order,input.actorId,false);
 await db.query('INSERT INTO dispatch.route_proposal_decision(tenant_id,proposal_id,decision,actor_id,reason_code) VALUES($1,$2,$3,$4,$5)',[tenantId,input.proposalId,state,input.actorId,state==='EXPIRED'?'EXPIRED':state==='CONFLICT'?'STATE_CHANGED':'DISPATCH_REJECTED']);
 return {proposalId:input.proposalId,runId:String(c.run.id),runVersion:Number(c.run.aggregate_version),state:state as 'EXPIRED'|'CONFLICT'|'REJECTED'};
}

export function createRouteProposalReader(pool:Pool){return async(tenantId:string,shiftId:string,driverId?:string)=>withTenantTransaction(pool,tenantId,'kavaroutes_api',async db=>{
 if(driverId && !(await db.query('SELECT 1 FROM execution.shift_policy_snapshot WHERE tenant_id=$1 AND id=$2 AND driver_id=$3',[tenantId,shiftId,driverId])).rowCount)conflict('route shift hidden');
 const c=await context(db,tenantId,shiftId);
 const proposals=(await db.query(`SELECT p.id,p.proposed_order,p.run_version,p.recorded_at,p.expires_at,
 coalesce(d.decision,CASE WHEN p.expires_at<=now() THEN 'EXPIRED' ELSE 'PENDING_DISPATCH_APPROVAL' END) AS state
 FROM dispatch.route_proposal p LEFT JOIN dispatch.route_proposal_decision d ON d.tenant_id=p.tenant_id AND d.proposal_id=p.id
 WHERE p.tenant_id=$1 AND p.shift_id=$2 ORDER BY p.recorded_at DESC,p.id LIMIT 101`,[tenantId,shiftId])).rows;
 if(proposals.length>100)conflict('route proposal pagination required');
 return {shiftId,runId:String(c.run.id),runVersion:Number(c.run.aggregate_version),factsVersion:Number(c.facts.version),
  shiftGeneration:String(c.shift.shift_generation),policyDigest:String(c.shift.policy_digest),mode:String(c.shift.effective_policy.routeChange.mode),
  nodes:c.nodes.map(n=>({nodeId:n.id,tripLegId:n.legId,kind:n.kind,locked:n.locked})),
  proposals:proposals.map(p=>({proposalId:String(p.id),nodeOrder:p.proposed_order as string[],runVersion:Number(p.run_version),state:String(p.state)}))};
 },'serializable');}
