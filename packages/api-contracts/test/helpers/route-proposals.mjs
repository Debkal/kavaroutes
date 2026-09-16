import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createPostgresRouteProposalService,createSyntheticTestVerifier,createWp007Api} from '../../dist/index.js';
import {resolveEffectiveDriverPolicy} from '../../../platform-engine/dist/domain/index.js';

export async function verifyRouteProposals(pool,tenantId,{runId,legId,vehicleId},recoverDecision){
 const binding=(await pool.query(`SELECT a.* FROM dispatch.assignment a WHERE a.tenant_id=$1 AND a.run_id=$2 AND NOT EXISTS(SELECT 1 FROM dispatch.assignment_supersession s WHERE s.tenant_id=a.tenant_id AND s.prior_assignment_id=a.id)`,[tenantId,runId])).rows[0];
 const otherLeg=randomUUID();
 await pool.query(`INSERT INTO intake.trip_leg(tenant_id,id,trip_request_id,ordinal,origin_address_id,destination_address_id,planned_start_at,planned_end_at)
 SELECT tenant_id,$3,trip_request_id,2,origin_address_id,destination_address_id,planned_start_at,planned_end_at FROM intake.trip_leg WHERE tenant_id=$1 AND id=$2`,[tenantId,legId,otherLeg]);
 await pool.query('INSERT INTO dispatch.run_leg(tenant_id,id,run_id,trip_leg_id,ordinal) VALUES($1,$2,$3,$4,2)',[tenantId,randomUUID(),runId,otherLeg]);
 await pool.query("INSERT INTO execution.leg_execution(tenant_id,id,run_id,trip_leg_id,lifecycle_reference,occurred_at) VALUES($1,$2,$3,$4,'dispatched',now())",[tenantId,randomUUID(),runId,otherLeg]);
 const time=Date.parse('2026-09-13T16:00:00Z'),last=time+3600000;
 const nodes=[legId,otherLeg].flatMap(id=>['PICKUP','DROPOFF'].map(kind=>({id:randomUUID(),legId:id,kind,locked:false,earliest:time,latest:last,serviceSeconds:5})));
 const startNode=randomUUID(),travelSeconds=Object.fromEntries([startNode,...nodes.map(n=>n.id)].flatMap(a=>nodes.map(n=>[`${a}:${n.id}`,10])));
 const facts={startAt:time,returnBy:last,startNode,requiredReturnNode:null,seats:2,wheelchairSpaces:1,legs:[legId,otherLeg].map(id=>({legId:id,seats:1,wheelchairSpaces:0,maximumRideSeconds:600})),travelSeconds};
 await pool.query('INSERT INTO dispatch.route_planning_facts VALUES($1,$2,1,$3::jsonb,$4::jsonb)',[tenantId,runId,JSON.stringify(nodes),JSON.stringify(facts)]);
 const verifier=createSyntheticTestVerifier(),dispatcher=await verifier.verify('Synthetic principal_dispatcher');
 const base=await verifier.verify('Synthetic principal_driver');
 const service=createPostgresRouteProposalService(pool);
 const runVersion=async()=>Number((await pool.query('SELECT aggregate_version FROM dispatch.run WHERE tenant_id=$1 AND id=$2',[tenantId,runId])).rows[0].aggregate_version);
 const begin=async(tier,mode,capability=false)=>{
  await pool.query("UPDATE execution.shift_policy_snapshot SET lifecycle='SHIFT_ENDED' WHERE tenant_id=$1 AND driver_id=$2",[tenantId,binding.driver_id]);
  const shiftId=randomUUID(),generation=randomUUID();
  const policy=resolveEffectiveDriverPolicy({organizationId:tenantId,driverId:binding.driver_id,assignmentId:binding.id,commercialTier:tier,workforceRelationship:'OWNER_OPERATOR',policyVersion:1,resolvedAt:new Date().toISOString(),organization:{routeChange:{mode,locked:false}},capabilities:new Set(capability?['driver-route:self-approve']:[])});
  await pool.query('INSERT INTO execution.shift_policy_snapshot(tenant_id,id,assignment_id,driver_id,shift_generation,policy_version,policy_digest,effective_policy,pinned_assignment_version) VALUES($1,$2,$3,$4,$5,1,$6,$7::jsonb,$8)',[tenantId,shiftId,binding.id,binding.driver_id,generation,policy.canonicalDigest,JSON.stringify(policy),binding.aggregate_version]);
  return {shiftId,principal:{...base,subjectId:binding.driver_id,capabilities:new Set([...base.capabilities,...(capability?['driver-route:self-approve']:[])])},request:{proposalId:randomUUID(),shiftGeneration:generation,policyDigest:policy.canonicalDigest,expectedRunVersion:await runVersion(),nodeOrder:[nodes[2].id,nodes[3].id,nodes[0].id,nodes[1].id],parkedAttestation:true}};
 };
 const strict=await begin('SMALL_BUSINESS','DISPATCH_APPROVAL_REQUIRED');
 const input={organizationId:tenantId,...strict,key:'route-strict-small-business-0001'};
 const app=await createWp007Api({routeProposalService:service,verifier:{verify:async value=>value==='Synthetic principal_driver'?strict.principal:verifier.verify(value)}});
 try {
  const url=`/v1/organizations/${tenantId}/driver/shifts/${strict.shiftId}/route-proposals`;
  const read=await app.inject({url,headers:{authorization:'Synthetic principal_driver'}});
  assert.equal(read.statusCode,200,read.body);assert.equal(read.json().nodes.length,4);
  assert.equal((await app.inject({url})).statusCode,401);
  const hidden=await app.inject({url:url.replace(strict.shiftId,randomUUID()),headers:{authorization:'Synthetic principal_driver'}});
  assert.notEqual(hidden.statusCode,200);
  const invalid=await app.inject({method:'POST',url,headers:{authorization:'Synthetic principal_driver','idempotency-key':'route-unknown-field-0001'},payload:{...strict.request,commercialTier:'SMALL_BUSINESS'}});
  assert.equal(invalid.statusCode,400,invalid.body);
  const missing=await app.inject({method:'POST',url,headers:{authorization:'Synthetic principal_driver','idempotency-key':input.key},payload:strict.request});assert.equal(missing.statusCode,428,missing.body);
  const posted=await app.inject({method:'POST',url,headers:{authorization:'Synthetic principal_driver','idempotency-key':input.key,'if-match':read.headers.etag},payload:strict.request});
  assert.equal(posted.statusCode,200,posted.body);assert.equal(posted.json().state,'PENDING_DISPATCH_APPROVAL');
 } finally {await app.close();}
 await assert.rejects(()=>service.read({organizationId:tenantId,principal:{...strict.principal,subjectId:randomUUID()},shiftId:strict.shiftId,dispatcher:false}));
 const pending=await service.submit(input);assert.equal(pending.body.state,'PENDING_DISPATCH_APPROVAL');
 assert.equal(await runVersion(),strict.request.expectedRunVersion,'proposal alone never mutates run');
 assert.deepEqual((await service.submit(input)).body,pending.body);
 await assert.rejects(()=>service.submit({...input,request:{...input.request,nodeOrder:[...input.request.nodeOrder].reverse()}}),'same idempotency key cannot change the proposal');
 await assert.rejects(()=>service.decide({organizationId:tenantId,principal:strict.principal,proposalId:strict.request.proposalId,key:'route-denied-decision-0001',request:{decision:'APPROVED',expectedRunVersion:strict.request.expectedRunVersion}}));
 const decision={organizationId:tenantId,principal:dispatcher,proposalId:strict.request.proposalId,key:`browser-command-${randomUUID()}`,request:{decision:'APPROVED',expectedRunVersion:strict.request.expectedRunVersion}};
 if(recoverDecision)await recoverDecision(decision,strict.shiftId);
 assert.equal((await service.decide(decision)).body.state,'APPROVED');
 assert.deepEqual((await service.decide(decision)).body,(await service.decide(decision)).body);
 assert.equal((await pool.query('SELECT trip_leg_id FROM dispatch.run_leg WHERE tenant_id=$1 AND run_id=$2 ORDER BY ordinal',[tenantId,runId])).rows[0].trip_leg_id,otherLeg);
 const enterprise=await begin('ENTERPRISE','AUTHORIZED_SELF_APPROVE',true);
 assert.equal((await service.submit({organizationId:tenantId,...enterprise,key:'route-enterprise-self-0001'})).body.state,'APPROVED','Enterprise owner policy/capability can self approve');
 const disabled=await begin('SMALL_BUSINESS','DISABLED');
 await assert.rejects(()=>service.submit({organizationId:tenantId,...disabled,key:'route-disabled-0001'}));
 const expired=await begin('ENTERPRISE','DISPATCH_APPROVAL_REQUIRED');
 await service.submit({organizationId:tenantId,...expired,key:'route-changed-facts-0001'});
 await pool.query('UPDATE dispatch.route_planning_facts SET version=version+1 WHERE tenant_id=$1 AND run_id=$2',[tenantId,runId]);
 assert.equal((await service.decide({...decision,proposalId:expired.request.proposalId,key:'route-changed-decision-0001',request:{decision:'APPROVED',expectedRunVersion:expired.request.expectedRunVersion}})).body.state,'CONFLICT');
 assert.equal((await pool.query('SELECT count(*) FROM dispatch.route_revision WHERE tenant_id=$1 AND run_id=$2',[tenantId,runId])).rows[0].count,'2');
 await assert.rejects(()=>pool.query('DELETE FROM dispatch.route_revision WHERE tenant_id=$1 AND run_id=$2',[tenantId,runId]),e=>e.code==='23514');
 assert.equal((await pool.query("SELECT count(*) FROM outbox.message WHERE tenant_id=$1 AND event_type='RouteProposalRecorded'",[tenantId])).rows[0].count,'5');
}
