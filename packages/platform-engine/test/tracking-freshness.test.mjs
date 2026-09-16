import test from 'node:test';
import assert from 'node:assert/strict';
import {assessTrackingFreshness} from '../dist/domain/index.js';
const base={now:120000,startedAt:0,lifecycle:'ACTIVE',collectionStopped:false,lastCapturedAt:119000,lastReceivedAt:119000};
test('silence creates a contact-driver signal without guessing network failure',()=>{
 assert.equal(assessTrackingFreshness(base).status,'UPDATES_CURRENT');
 const lost=assessTrackingFreshness({...base,now:180001});assert.equal(lost.status,'UPDATES_OVERDUE');assert.equal(lost.contactDriver,true);assert.equal(lost.reason,'NO_RECENT_UPDATE_UNKNOWN_CAUSE');
 assert.equal(assessTrackingFreshness({...base,lastCapturedAt:1000,lastReceivedAt:120000}).status,'UPDATES_OVERDUE','uploading an old batch is not live tracking');
});
test('no first sample, intentional stops and accepted signoff remain distinct',()=>{
 assert.equal(assessTrackingFreshness({...base,now:30000,lastCapturedAt:null,lastReceivedAt:null}).status,'WAITING_FOR_FIRST_UPDATE');
 assert.equal(assessTrackingFreshness({...base,lastCapturedAt:null,lastReceivedAt:null}).status,'NO_UPDATES');
 const stopped=assessTrackingFreshness({...base,collectionStopped:true,stopReason:'SAFETY'});assert.equal(stopped.status,'TRACKING_STOPPED');assert.equal(stopped.reason,'DRIVER_REPORTED_SAFETY');assert.equal(stopped.contactDriver,true);
 assert.equal(assessTrackingFreshness({...base,lifecycle:'SHIFT_ENDED',collectionStopped:true}).contactDriver,false);
 assert.equal(assessTrackingFreshness({...base,lifecycle:'INVALIDATE_REVIEW'}).status,'STATUS_UNAVAILABLE');
});
test('time alone changes status and a fresh sample recovers it',()=>{
 const stale=assessTrackingFreshness({...base,now:200000});assert.equal(stale.status,'UPDATES_OVERDUE');
 const recovered=assessTrackingFreshness({...base,now:200000,lastCapturedAt:199999,lastReceivedAt:200000});assert.equal(recovered.status,'UPDATES_CURRENT');assert.equal(recovered.contactDriver,false);
});
