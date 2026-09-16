import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateSyntheticReturn} from '../dist/domain/shift-return.js';
test('disabled return needs no sample; advisory and required classify neutral fixture evidence identically',()=>{
 const now=Date.now();assert.equal(evaluateSyntheticReturn('DISABLED',null,null,now),'NOT_REQUIRED');
 for(const mode of ['ADVISORY','REQUIRED_WITH_AUDITED_OVERRIDE']){
  assert.equal(evaluateSyntheticReturn(mode,null,60,now),'UNAVAILABLE');
  assert.equal(evaluateSyntheticReturn(mode,{fixture:'AT_RETURN',capturedAt:now},null,now),'UNAVAILABLE');
  for(const [fixture,result] of [['AT_RETURN','PASS'],['OUTSIDE_RETURN','OUTSIDE'],['INACCURATE','INACCURATE']])assert.equal(evaluateSyntheticReturn(mode,{fixture,capturedAt:now},60,now),result);
  for(const capturedAt of [now-60001,now+30001,NaN])assert.equal(evaluateSyntheticReturn(mode,{fixture:'AT_RETURN',capturedAt},60,now),'STALE');
 }
 assert.throws(()=>evaluateSyntheticReturn('UNKNOWN',null,null,now),/PINNED_RETURN_POLICY_INVALID/);
});
