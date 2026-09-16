import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createPostgresDriverPrecheckService,createSyntheticTestVerifier,precheckItems} from '../../dist/index.js';
export async function verifyDriverPostcheck(pool,tenantId,runId){
 const row=(await pool.query(`SELECT s.*,a.vehicle_id FROM execution.shift_policy_snapshot s JOIN dispatch.assignment a ON a.tenant_id=s.tenant_id AND a.id=s.assignment_id WHERE s.tenant_id=$1 AND a.run_id=$2 AND s.lifecycle='ACTIVE'`,[tenantId,runId])).rows[0];
 const base=await createSyntheticTestVerifier().verify('Synthetic principal_driver'),principal={...base,subjectId:row.driver_id};
 const pre=createPostgresDriverPrecheckService(pool),post=createPostgresDriverPrecheckService(pool,{stage:'POST'});
 const req={shiftGeneration:row.shift_generation,vehicleId:row.vehicle_id,policyDigest:row.policy_digest,expectedVersion:Number(row.aggregate_version),capturedAt:new Date().toISOString(),photos:[],inspection:{decision:'COMPLETED',definitionVersion:'inspection-synthetic-v2',entries:precheckItems.map(item=>({item,response:'NO_DEFECT'}))},odometer:{decision:'COMPLETED',value:100,fuelLevel:'FULL'}};
 const input={organizationId:tenantId,shiftId:row.id,principal,key:randomUUID(),request:req};
 const accepted=await pre.submit(input);
 const postInput={...input,key:randomUUID(),request:{...req,expectedVersion:accepted.body.resourceVersion,odometer:{...req.odometer,value:120}}};
 await assert.rejects(()=>post.submit(postInput),e=>e.code==='UNFINISHED_SHIFT_WORK');
 // Fixture-only terminal states isolate post-check guards; this is not trip execution evidence.
 await pool.query("UPDATE execution.leg_execution SET lifecycle_reference='completed' WHERE tenant_id=$1 AND run_id=$2",[tenantId,runId]);
 await assert.rejects(()=>post.submit({...postInput,key:randomUUID(),request:{...postInput.request,odometer:{...req.odometer,value:99}}}),e=>e.code==='ENDING_ODOMETER_BELOW_START');
 const result=await post.submit(postInput);assert.equal(result.body.odometer,120);assert.equal(result.body.inspectionOutcome,'COMPLETED');
 assert.deepEqual((await post.submit(postInput)).body,result.body);
 await assert.rejects(()=>post.submit({...postInput,key:randomUUID(),request:{...postInput.request,expectedVersion:result.body.resourceVersion}}),e=>e.code==='VEHICLE_CHECK_ALREADY_RECORDED');
 assert.equal((await pool.query('SELECT odometer FROM execution.driver_precheck_decision WHERE tenant_id=$1 AND shift_id=$2',[tenantId,row.id])).rows[0].odometer,100);
 await assert.rejects(()=>pool.query('DELETE FROM execution.driver_postcheck_decision WHERE tenant_id=$1 AND shift_id=$2',[tenantId,row.id]),e=>e.code==='23514');
 return {shiftId:row.id,driverId:row.driver_id,version:result.body.resourceVersion};
}
