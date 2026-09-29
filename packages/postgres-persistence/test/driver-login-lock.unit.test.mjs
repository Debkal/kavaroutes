import assert from 'node:assert/strict';
import test from 'node:test';
import {hashDriverPassword,verifyDriverLogin} from '../dist/driver-credentials.js';

const password='disposable-test-password';
const hash=hashDriverPassword(password).value;
function client(lockedUntil){
  const row={driver_id:'44444444-4444-4444-8444-444444444444',login_id:'driver-test',status:'LOCKED',password_hash:hash,
    locked_until:lockedUntil,failed_attempts:5,credential_version:2,claimed_at:new Date(),last_login_at:null};
  let writes=0;
  return {get writes(){return writes;},query:async sql=>{
    if(sql.startsWith('SELECT'))return {rows:[{...row}]};
    writes++;
    if(sql.includes("SET status='ACTIVE'")){row.status='ACTIVE';row.failed_attempts=0;row.locked_until=null;}
    else if(sql.includes('last_login_at=now()')){row.credential_version++;row.last_login_at=new Date();}
    else if(sql.includes('failed_attempts = failed_attempts + 1')){row.failed_attempts++;}
    return {rows:[{...row}]};
  }};
}
test('Driver can sign in after a timed password lock expires',async()=>{
  const db=client(new Date(Date.now()-1000));
  const result=await verifyDriverLogin(db,'business',{loginId:'driver-test',password});
  assert.equal(result.accepted,true);
  assert.equal(result.state.status,'ACTIVE');
  assert.equal(db.writes,2);
});
test('active timed and administrative locks cannot be cleared by sign-in',async()=>{
  for(const expiry of [new Date(Date.now()+60_000),null]){
    const db=client(expiry);
    assert.equal((await verifyDriverLogin(db,'business',{loginId:'driver-test',password})).accepted,false);
    assert.equal(db.writes,0);
  }
});
test('a wrong password after lock expiry restarts the failure count',async()=>{
  const db=client(new Date(Date.now()-1000));
  const result=await verifyDriverLogin(db,'business',{loginId:'driver-test',password:'wrong-password'});
  assert.equal(result.accepted,false);
  assert.equal(result.reason,'BAD_PASSWORD');
  assert.equal(db.writes,2);
});
