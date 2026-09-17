import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {Type,type Static} from 'typebox';
import {createDispatchBoardReader,createPostgresPersistence,PersistenceConflict} from '@kavaroutes/postgres-persistence';
import {authorize,companyBranchScope,companyFleetScope,type SyntheticPrincipal} from './security.js';
import {requestFingerprint} from './protocol.js';

const id=()=>Type.String({format:'uuid'});
const nullableId=()=>Type.Union([id(),Type.Null()]);
const label=()=>Type.String({minLength:1,maxLength:512});
const instant=()=>Type.String({format:'date-time'});
export const AssignDispatchRunRequestSchema=Type.Object({driverId:id(),vehicleId:id(),expectedVersion:Type.Integer({minimum:1})},{additionalProperties:false,$id:'AssignDispatchRunRequest'});
export type AssignDispatchRunRequest=Static<typeof AssignDispatchRunRequestSchema>;
export const AssignDispatchRunReceiptSchema=Type.Object({assignmentId:id(),runId:id(),version:Type.Integer({minimum:1}),serviceDate:Type.String({format:'date'}),supersedes:Type.Optional(id())},{additionalProperties:false,$id:'AssignDispatchRunReceipt'});
export const UnassignDispatchRunRequestSchema=Type.Object({expectedVersion:Type.Integer({minimum:1})},{additionalProperties:false,$id:'UnassignDispatchRunRequest'});
export type UnassignDispatchRunRequest=Static<typeof UnassignDispatchRunRequestSchema>;
export const UnassignDispatchRunReceiptSchema=Type.Object({runId:id(),version:Type.Integer({minimum:1}),
 serviceDate:Type.String({format:'date'}),releasedAssignmentId:id()},{additionalProperties:false,$id:'UnassignDispatchRunReceipt'});
export type UnassignDispatchRunReceipt=Static<typeof UnassignDispatchRunReceiptSchema>;
export const DispatchBoardSchema=Type.Object({serviceDate:Type.String({format:'date'}),
 runs:Type.Array(Type.Object({runId:id(),version:Type.Integer({minimum:1}),expectedTag:Type.String(),lifecycle:label(),plannedStartAt:instant(),plannedEndAt:instant(),serviceTimezone:label(),assignmentId:nullableId(),driverId:nullableId(),vehicleId:nullableId()},{additionalProperties:false}),{maxItems:500}),
 legs:Type.Array(Type.Object({runId:id(),tripLegId:id(),tripId:id(),ordinal:Type.Integer({minimum:1}),riderLabel:label(),pickupLabel:label(),dropoffLabel:label(),plannedStartAt:instant(),plannedEndAt:instant(),tripState:label(),executionId:nullableId(),lifecycle:label(),version:Type.Integer({minimum:0})},{additionalProperties:false}),{maxItems:2000}),
 drivers:Type.Array(Type.Object({id:id(),label:label()},{additionalProperties:false}),{maxItems:500}),vehicles:Type.Array(Type.Object({id:id(),label:label()},{additionalProperties:false}),{maxItems:500}),
},{additionalProperties:false,$id:'DispatchBoard'});
export const DispatchPlanLegSchema=Type.Object({
 riderReference:label(),pickupLabel:label(),dropoffLabel:label(),
 localServiceTime:Type.String({pattern:'^\\d{2}:\\d{2}:\\d{2}$'}),resolvedServiceAt:instant(),
 resolvedUtcOffsetSeconds:Type.Integer({minimum:-50400,maximum:50400}),
 plannedStartAt:instant(),plannedEndAt:instant(),
 pickupRequired:Type.Boolean(),dropoffRequired:Type.Boolean(),mobilitySecurementRequired:Type.Boolean(),
},{additionalProperties:false,$id:'DispatchPlanLeg'});
export const PlanDispatchRunRequestSchema=Type.Object({
 serviceDate:Type.String({format:'date'}),serviceTimezone:label(),
 plannedStartAt:instant(),plannedEndAt:instant(),
 seatsRequired:Type.Optional(Type.Integer({minimum:1,maximum:100})),
 wheelchairSpacesRequired:Type.Optional(Type.Integer({minimum:0,maximum:20})),
 clientId:Type.Optional(id()),
 legs:Type.Array(DispatchPlanLegSchema,{minItems:1,maxItems:25}),
},{additionalProperties:false,$id:'PlanDispatchRunRequest'});
export type PlanDispatchRunRequest=Static<typeof PlanDispatchRunRequestSchema>;
export const PlanDispatchRunReceiptSchema=Type.Object({
 runId:id(),version:Type.Integer({minimum:1}),serviceDate:Type.String({format:'date'}),
 legCount:Type.Integer({minimum:1,maximum:25}),tripLegIds:Type.Array(id(),{minItems:1,maxItems:25}),
},{additionalProperties:false,$id:'PlanDispatchRunReceipt'});
export type PlanDispatchRunReceipt=Static<typeof PlanDispatchRunReceiptSchema>;
/** A planned run may not span more than a single service day. */
const MAX_RUN_WINDOW_MINUTES=1440;
/** intake.trip_request checks resolved_utc_offset_seconds into +-14h (50400s). A wider
 * contract bound would validate here and then fail as a database error, so the
 * command refuses the same range the column does. */
const MAX_UTC_OFFSET_SECONDS=50400;
/** The planned-run receipt this service returns. Declared here so the public
 * service type never has to name a persistence-internal type; the mapper below
 * is the only place the two shapes meet. */
export interface PlannedRunReceipt {
 readonly runId:string;readonly version:number;readonly serviceDate:string;
 readonly legCount:number;readonly tripLegIds:readonly string[];
}
/** TS2883 fix: `plan()` returned `StoredMutationResult<PlanDispatchRunReceipt>`
 * inferred from `executeIdempotentMutation`, which drags
 * `DispatchPlanReceipt` (a `@kavaroutes/postgres-persistence` type) into this
 * package's emitted declaration. Declaring the return type keeps the
 * persistence type behind the package boundary, which is what the export map
 * promises and what the container build (which builds packages before
 * apps/api-host) requires. The body is unchanged. */
export function createPostgresDispatchService(pool:Pool,options:{etag:(id:string,version:number,projection:string)=>string}) {
 const persistence=createPostgresPersistence(pool),reader=createDispatchBoardReader(pool);
 const access=(organizationId:string,principal:SyntheticPrincipal,command:boolean)=>authorize(principal,organizationId,{capability:command?'dispatch:command':'dispatch:read',purpose:'ASSIGNED_SERVICE_DELIVERY',branchScope:companyBranchScope(organizationId),fleetScope:companyFleetScope(organizationId)});
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

  /** Remove the driver and vehicle from a run. The historical assignment is released
   * rather than superseded, the reservations are cancelled and the run returns to
   * planned with its legs un-started; recorded work or an open shift refuse it. */
  async unassign(input:{organizationId:string;principal:SyntheticPrincipal;runId:string;key:string;ifMatch:string;request:UnassignDispatchRunRequest}){
   access(input.organizationId,input.principal,true);
   if(options.etag(input.runId,input.request.expectedVersion,'dispatch-run-v1')!==input.ifMatch)throw new PersistenceConflict('stale-version','run tag mismatch');
   const fingerprint=requestFingerprint({kind:'unassignDispatchRun',runId:input.runId,ifMatch:input.ifMatch,...input.request});
   return persistence.executeIdempotentMutation<UnassignDispatchRunReceipt>({tenantId:input.organizationId,actorReference:input.principal.id,operationId:'unassignDispatchRun',
     key:input.key,fingerprint,recordId:randomUUID(),expiresAt:new Date(Date.now()+86_700_000),isolationLevel:'serializable'},async tx=>{
    const receipt=await tx.releaseDispatchAssignment({runId:input.runId,expectedVersion:input.request.expectedVersion,reason:'DISPATCH_REMOVED'});
    await tx.appendAudit({auditId:randomUUID(),aggregateKind:'run',aggregateId:receipt.runId,aggregateVersion:receipt.version,
      actionReference:'dispatch.assignment.released',actorReference:input.principal.id});
    return {statusCode:200,body:receipt,headers:{etag:options.etag(receipt.runId,receipt.version,'dispatch-run-v1')},resultReference:receipt.runId};
   }).catch((error:unknown)=>{
    if(error && typeof error==='object' && 'code' in error && ['40001','40P01'].includes(String(error.code)))throw new PersistenceConflict('stale-version','concurrent dispatch change requires refresh');
    throw error;
   });
  },
  async plan(input:{organizationId:string;principal:SyntheticPrincipal;key:string;request:PlanDispatchRunRequest}){
   access(input.organizationId,input.principal,true);
   const request=input.request;
   const start=Date.parse(request.plannedStartAt),end=Date.parse(request.plannedEndAt);
   if(!(start<end)||end-start>MAX_RUN_WINDOW_MINUTES*60_000)throw new PersistenceConflict('relationship','run window invalid');
   for(const leg of request.legs){
    const legStart=Date.parse(leg.plannedStartAt),legEnd=Date.parse(leg.plannedEndAt);
    if(!(legStart<legEnd)||legStart<start||legEnd>end||leg.resolvedServiceAt!==leg.plannedStartAt||
      Math.abs(leg.resolvedUtcOffsetSeconds)>MAX_UTC_OFFSET_SECONDS)
     throw new PersistenceConflict('relationship','leg window must sit inside the run window and carry its own resolved service time');
   }
   const fingerprint=requestFingerprint({kind:'planDispatchRun',...request});
   return persistence.executeIdempotentMutation<PlanDispatchRunReceipt>({tenantId:input.organizationId,actorReference:input.principal.id,operationId:'planDispatchRun',key:input.key,fingerprint,recordId:randomUUID(),expiresAt:new Date(Date.now()+86_700_000),isolationLevel:'serializable'},async tx=>{
    const planned=await tx.planDispatchRun({
     serviceDate:request.serviceDate,serviceTimezone:request.serviceTimezone,
     plannedStartAt:new Date(start),plannedEndAt:new Date(end),
     seatsRequired:request.seatsRequired??1,wheelchairSpacesRequired:request.wheelchairSpacesRequired??0,
     clientId:request.clientId??null,
     legs:request.legs.map(leg=>({riderReference:leg.riderReference,pickupLabel:leg.pickupLabel,dropoffLabel:leg.dropoffLabel,
      localServiceTime:leg.localServiceTime,resolvedServiceAt:new Date(leg.resolvedServiceAt),resolvedUtcOffsetSeconds:leg.resolvedUtcOffsetSeconds,
      plannedStartAt:new Date(leg.plannedStartAt),plannedEndAt:new Date(leg.plannedEndAt),
      pickupRequired:leg.pickupRequired,dropoffRequired:leg.dropoffRequired,mobilitySecurementRequired:leg.mobilitySecurementRequired})),
    });
    const receipt:PlanDispatchRunReceipt={runId:planned.runId,version:planned.version,serviceDate:planned.serviceDate,legCount:planned.legCount,tripLegIds:[...planned.tripLegIds]};
    await tx.appendAudit({auditId:randomUUID(),aggregateKind:'run',aggregateId:receipt.runId,aggregateVersion:receipt.version,actionReference:'dispatch.route.planned',actorReference:input.principal.id});
    return {statusCode:201,body:receipt,headers:{etag:options.etag(receipt.runId,receipt.version,'dispatch-run-v1')},resultReference:receipt.runId};
   }).catch((error:unknown)=>{
    if(error && typeof error==='object' && 'code' in error && ['40001','40P01'].includes(String(error.code)))throw new PersistenceConflict('stale-version','concurrent dispatch change requires refresh');
    throw error;
   });
  },
 };
}
export type DispatchService=ReturnType<typeof createPostgresDispatchService>;
