import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {Type,type Static} from 'typebox';
import {createDispatchBoardReader,createPostgresPersistence,PersistenceConflict} from '@kavaroutes/postgres-persistence';
import {authorize,type SyntheticPrincipal} from './security.js';
import {requestFingerprint} from './protocol.js';

const id=()=>Type.String({format:'uuid'});
const nullableId=()=>Type.Union([id(),Type.Null()]);
const label=()=>Type.String({minLength:1,maxLength:512});
const instant=()=>Type.String({format:'date-time'});
export const AssignDispatchRunRequestSchema=Type.Object({driverId:id(),vehicleId:id(),expectedVersion:Type.Integer({minimum:1})},{additionalProperties:false,$id:'AssignDispatchRunRequest'});
export type AssignDispatchRunRequest=Static<typeof AssignDispatchRunRequestSchema>;
export const AssignDispatchRunReceiptSchema=Type.Object({assignmentId:id(),runId:id(),version:Type.Integer({minimum:1}),serviceDate:Type.String({format:'date'}),supersedes:Type.Optional(id())},{additionalProperties:false,$id:'AssignDispatchRunReceipt'});
export const DispatchBoardSchema=Type.Object({serviceDate:Type.String({format:'date'}),
 runs:Type.Array(Type.Object({runId:id(),version:Type.Integer({minimum:1}),expectedTag:Type.String(),lifecycle:label(),plannedStartAt:instant(),plannedEndAt:instant(),serviceTimezone:label(),assignmentId:nullableId(),driverId:nullableId(),vehicleId:nullableId()},{additionalProperties:false}),{maxItems:500}),
 legs:Type.Array(Type.Object({runId:id(),tripLegId:id(),tripId:id(),ordinal:Type.Integer({minimum:1}),riderLabel:label(),pickupLabel:label(),dropoffLabel:label(),plannedStartAt:instant(),plannedEndAt:instant(),tripState:label(),executionId:nullableId(),lifecycle:label(),version:Type.Integer({minimum:0})},{additionalProperties:false}),{maxItems:2000}),
 drivers:Type.Array(Type.Object({id:id(),label:label()},{additionalProperties:false}),{maxItems:500}),vehicles:Type.Array(Type.Object({id:id(),label:label()},{additionalProperties:false}),{maxItems:500}),
},{additionalProperties:false,$id:'DispatchBoard'});
export function createPostgresDispatchService(pool:Pool,options:{etag:(id:string,version:number,projection:string)=>string}) {
 const persistence=createPostgresPersistence(pool),reader=createDispatchBoardReader(pool);
 const access=(organizationId:string,principal:SyntheticPrincipal,command:boolean)=>authorize(principal,organizationId,{capability:command?'dispatch:command':'dispatch:read',purpose:'ASSIGNED_SERVICE_DELIVERY',branchScope:'branch:synthetic-all',fleetScope:'fleet:synthetic-all'});
 return {
  async read(organizationId:string,principal:SyntheticPrincipal,serviceDate:string){
   access(organizationId,principal,false);
   const board=await reader(organizationId,serviceDate);
   return {...board,runs:board.runs.map(run=>({...run,expectedTag:options.etag(run.runId,run.version,'dispatch-run-v1')}))};
  },
  async assign(input:{organizationId:string;principal:SyntheticPrincipal;runId:string;key:string;ifMatch:string;request:AssignDispatchRunRequest}){
   access(input.organizationId,input.principal,true);
   if(options.etag(input.runId,input.request.expectedVersion,'dispatch-run-v1')!==input.ifMatch)throw new PersistenceConflict('stale-version','run tag mismatch');
   const fingerprint=requestFingerprint({runId:input.runId,ifMatch:input.ifMatch,...input.request});
   return persistence.executeIdempotentMutation({tenantId:input.organizationId,actorReference:input.principal.id,operationId:'assignDispatchRun',key:input.key,fingerprint,recordId:randomUUID(),expiresAt:new Date(Date.now()+86_700_000),isolationLevel:'serializable'},async tx=>{
    const receipt=await tx.assignDispatchRun({runId:input.runId,...input.request,assignmentId:randomUUID()});
    await tx.appendAudit({auditId:randomUUID(),aggregateKind:'run',aggregateId:input.runId,aggregateVersion:receipt.version,actionReference:'dispatch.assignment.committed',actorReference:input.principal.id});
    const messageId=randomUUID(),now=new Date(),retainUntil=new Date(Date.now()+2_592_100_000);
    // Each immutable binding has its own version-one stream. Run versions may predate this publisher.
    await tx.appendOutboxMessage({messageId,eventId:randomUUID(),aggregateType:'ASSIGNMENT',aggregateId:receipt.assignmentId,aggregateVersion:1,eventType:'DispatchAssignmentCommitted',schemaVersion:'v1',occurredAt:now,commandId:randomUUID(),idempotencyReferenceHash:fingerprint,correlationId:randomUUID(),source:'kavaroutes.api',classificationReference:'OPERATIONAL_SENSITIVE',purposeReference:'ASSIGNED_SERVICE_DELIVERY',policyReference:'privacy-synthetic-v1',payload:{runId:receipt.runId,runVersion:receipt.version},retainUntil});
    await tx.appendOutboxDelivery({deliveryId:randomUUID(),messageId,route:'realtime-signal',jobType:'kr.realtime-signal.dispatch-assignment.v1',availableAt:now,retainUntil});
    return {statusCode:200,body:receipt,headers:{etag:options.etag(receipt.runId,receipt.version,'dispatch-run-v1')},resultReference:receipt.assignmentId};
   }).catch((error:unknown)=>{
    // PostgreSQL aborted the transaction; no partial assignment/audit/receipt can survive.
    if(error && typeof error==='object' && 'code' in error && ['40001','40P01'].includes(String(error.code)))throw new PersistenceConflict('stale-version','concurrent dispatch change requires refresh');
    throw error;
   });
  },
 };
}
export type DispatchService=ReturnType<typeof createPostgresDispatchService>;
