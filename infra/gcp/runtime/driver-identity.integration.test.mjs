import test from 'node:test';
import assert from 'node:assert/strict';
import {createWp007Api,createWp007PostgresApplication,createPostgresDriverLoginService,createSyntheticTestVerifier} from '@kavaroutes/api-contracts';
import {createDriverItineraryReader,withTenantTransaction} from '@kavaroutes/postgres-persistence';
import {withFreshDatabase} from '../../../packages/postgres-persistence/scripts/database-fixture.mjs';
import {createDriverSessions} from './driver-sessions.mjs';

const connectionString=process.env.WP007_DATABASE_URL;
const organizationId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const root=`/v1/organizations/${organizationId}`;
const dispatcher={authorization:'Synthetic principal_dispatcher'};
const bootstrap={};

test('a newly created driver claims access and receives only their itinerary', {skip:!connectionString},async()=>{
  await withFreshDatabase(connectionString,'driver_identity',async pool=>{
    await withTenantTransaction(pool,organizationId,'kavaroutes_api',client=>client.query(
      "INSERT INTO platform.organization (tenant_id,id,synthetic_name) VALUES ($1,$1,'Driver identity test')",[organizationId]));
    const sessions=createDriverSessions({synthetic:createSyntheticTestVerifier(),credentialVersion:async(tenant,driverId)=>
      withTenantTransaction(pool,tenant,'kavaroutes_api',async client=>{
        const row=(await client.query('SELECT status,credential_version FROM platform.driver_credential WHERE tenant_id=$1 AND driver_id=$2',[tenant,driverId])).rows[0];
        return row?{status:String(row.status),version:Number(row.credential_version)}:null;
      })});
    const app=await createWp007Api({application:createWp007PostgresApplication(pool,{etagSecret:'synthetic-etag-secret-driver-identity-test-2026'}),
      verifier:{verify:value=>sessions.verify(value)},driverItineraryReader:createDriverItineraryReader(pool),
      driverLoginService:createPostgresDriverLoginService(pool,{allowUnauthenticatedLogin:true}),publicDriverLogin:true,
      issueDriverSession:(tenant,state)=>sessions.issue(tenant,state)});
    try{
      const created=await app.inject({method:'POST',url:`${root}/fleet/drivers/commands/create`,headers:{...dispatcher,'idempotency-key':'driver-identity-create-20260923'},
        payload:{displayName:'Test Driver',loginId:'test-driver',workforceRelationship:'EMPLOYEE'}});
      assert.equal(created.statusCode,201,created.body);
      const {driverId,inviteCode}=created.json();
      const claimed=await app.inject({method:'POST',url:`${root}/driver-logins/${driverId}/commands/claim`,headers:{...bootstrap,'idempotency-key':'driver-identity-claim-20260923'},
        payload:{driverId,inviteCode,password:'test-password-2026'}});
      assert.equal(claimed.statusCode,200,claimed.body);
      const authorization=`DriverSession ${claimed.json().sessionToken}`;
      const itinerary=await app.inject({url:`${root}/driver/itineraries/2026-09-24`,headers:{authorization}});
      assert.equal(itinerary.statusCode,200,itinerary.body);
      assert.equal(itinerary.json().driverReference,driverId);
      assert.deepEqual(itinerary.json().legs,[]);
      const verified=await app.inject({method:'POST',url:`${root}/driver-logins/commands/verify`,headers:{...bootstrap,'idempotency-key':'driver-identity-verify-20260923'},
        payload:{loginId:'test-driver',password:'test-password-2026'}});
      assert.equal(verified.statusCode,200,verified.body);
      assert.notEqual(verified.json().sessionToken,claimed.json().sessionToken);
      assert.equal((await app.inject({url:`${root}/driver/itineraries/2026-09-24`,headers:{authorization}})).statusCode,401);
      assert.equal((await app.inject({url:`${root}/driver/itineraries/2026-09-24`,headers:{authorization:`DriverSession ${verified.json().sessionToken}`}})).statusCode,200);
    }finally{await app.close();}
  });
});
