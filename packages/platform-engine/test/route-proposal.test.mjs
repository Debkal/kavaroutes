import test from 'node:test';
import assert from 'node:assert/strict';
import {validateFutureRoute} from '../dist/domain/index.js';
const nodes=[['p1','a','PICKUP'],['d1','a','DROPOFF'],['p2','b','PICKUP'],['d2','b','DROPOFF'],['break',null,'BREAK'],['return',null,'RETURN']].map(([id,legId,kind])=>({id,legId,kind,locked:false,earliest:0,latest:1000000,serviceSeconds:5}));
const travelSeconds=Object.fromEntries(['start',...nodes.map(n=>n.id)].flatMap(a=>nodes.map(n=>[`${a}:${n.id}`,10])));
const rules={startAt:0,returnBy:1000000,startNode:'start',requiredReturnNode:'return',seats:2,wheelchairSpaces:1,legs:['a','b'].map(legId=>({legId,seats:1,wheelchairSpaces:0,maximumRideSeconds:600})),travelSeconds};
const valid=['p2','d2','p1','d1','break','return'];
test('server route constraints accept a valid future reorder and preserve immutable input',()=>{
 const before=JSON.stringify({nodes,rules});assert.equal(validateFutureRoute(nodes,valid,rules).length,6);assert.equal(JSON.stringify({nodes,rules}),before);
});
test('ownership, locked prefix, pickup/dropoff, return and missing data fail closed',()=>{
 for(const order of [['p2','d2','p1','d1','return','break'],['d2','p2','p1','d1','break','return'],['other','d2','p1','d1','break','return'],['p2','p2','p1','d1','break','return']])assert.throws(()=>validateFutureRoute(nodes,order,rules));
 assert.throws(()=>validateFutureRoute(nodes.map(n=>({...n,locked:n.id==='d1'})),valid,rules),/STARTED_OR_LOCKED_NODE/);
 assert.throws(()=>validateFutureRoute(nodes,valid,{...rules,travelSeconds:{}}),/TRAVEL_CONSTRAINTS_REQUIRED/);
});
test('capacity, time windows, ride time and return deadline reject infeasible orders',()=>{
 assert.throws(()=>validateFutureRoute(nodes,['p1','p2','d1','d2','break','return'],{...rules,seats:1}),/CAPACITY/);
 assert.throws(()=>validateFutureRoute(nodes.map(n=>({...n,latest:1})),valid,rules),/TIME_WINDOW/);
 assert.throws(()=>validateFutureRoute(nodes,valid,{...rules,legs:rules.legs.map(l=>({...l,maximumRideSeconds:1}))}),/MAXIMUM_RIDE/);
 assert.throws(()=>validateFutureRoute(nodes,valid,{...rules,returnBy:100}),/BREAK_OR_RETURN/);
});
