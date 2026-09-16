import type {Pool} from 'pg';
import {Type,type Static,type TSchema} from 'typebox';
import {createBrowserCommandRecoveryStore,type BrowserCommandRecord,type JsonValue} from '@kavaroutes/postgres-persistence';
import {authorize,type SyntheticPrincipal,type Capability} from './security.js';
import {ProtocolError} from './protocol.js';
import {mappedError} from './api-lifecycle.js';
import type {Wp007Application} from './application.js';
import {StrongEtagSchema,TripCreateRequestSchema,CancelTripRequestSchema,DispatcherTripSchema,TripCommandResponseSchema} from './schemas.js';
import {AssignDispatchRunRequestSchema,AssignDispatchRunReceiptSchema,type DispatchService} from './dispatch-board.js';
import {RouteDecisionRequestSchema,RouteProposalReceiptSchema,type RouteProposalService} from './route-proposals.js';
import {DriverReturnOverrideRequestSchema,DriverClosureReceiptSchema,type DriverClosureService} from './driver-closure.js';

const closed={additionalProperties:false},id=()=>Type.String({format:'uuid'});
const ref=<T extends TSchema>(schema:T)=>Type.Unsafe<Static<T>>({$ref:String((schema as {$id?:unknown}).$id)});
export const BrowserCommandEnvelopeSchema=Type.Union([
 Type.Object({kind:Type.Literal('CREATE_TRIP'),body:ref(TripCreateRequestSchema)},closed),
 Type.Object({kind:Type.Literal('CANCEL_TRIP'),resourceId:id(),expectedTag:ref(StrongEtagSchema),body:ref(CancelTripRequestSchema)},closed),
 Type.Object({kind:Type.Literal('ASSIGN_RUN'),resourceId:id(),expectedTag:ref(StrongEtagSchema),body:ref(AssignDispatchRunRequestSchema)},closed),
 Type.Object({kind:Type.Literal('DECIDE_ROUTE'),resourceId:id(),expectedTag:ref(StrongEtagSchema),body:ref(RouteDecisionRequestSchema)},closed),
 Type.Object({kind:Type.Literal('OVERRIDE_RETURN'),resourceId:id(),body:ref(DriverReturnOverrideRequestSchema)},closed),
],{$id:'BrowserCommandEnvelope'});
export type BrowserCommandEnvelope=Static<typeof BrowserCommandEnvelopeSchema>;
export const BrowserCommandPrepareSchema=Type.Object({id:id(),envelope:ref(BrowserCommandEnvelopeSchema)},{...closed,$id:'BrowserCommandPrepare'});
const result=Type.Union([
 Type.Object({outcome:Type.Literal('ACCEPTED'),statusCode:Type.Integer({minimum:200,maximum:201}),body:Type.Union([ref(DispatcherTripSchema),ref(TripCommandResponseSchema),ref(AssignDispatchRunReceiptSchema),ref(RouteProposalReceiptSchema),ref(DriverClosureReceiptSchema)]),etag:Type.Union([ref(StrongEtagSchema),Type.Null()])},closed),
 Type.Object({outcome:Type.Literal('REJECTED'),statusCode:Type.Integer({minimum:400,maximum:499}),code:Type.String({pattern:'^[A-Z][A-Z0-9_]{0,127}$'})},closed),
]);
export const BrowserCommandViewSchema=Type.Object({id:id(),envelope:ref(BrowserCommandEnvelopeSchema),result:Type.Union([result,Type.Null()]),expired:Type.Boolean(),acknowledged:Type.Boolean()},{...closed,$id:'BrowserCommandView'});
export const BrowserCommandPendingSchema=Type.Object({command:Type.Union([ref(BrowserCommandViewSchema),Type.Null()])},{...closed,$id:'BrowserCommandPending'});
type Context={organizationId:string;principal:SyntheticPrincipal};
type Services={application:Wp007Application;dispatchService:DispatchService;routeProposalService:RouteProposalService;driverClosureService:DriverClosureService};
const permissions:Record<BrowserCommandEnvelope['kind'],Capability>={CREATE_TRIP:'trips:write',CANCEL_TRIP:'trips:command',ASSIGN_RUN:'dispatch:command',DECIDE_ROUTE:'dispatch:command',OVERRIDE_RETURN:'driver-policy:override'};
function access(c:Context,kind:BrowserCommandEnvelope['kind']){
 authorize(c.principal,c.organizationId,{capability:permissions[kind],purpose:kind==='CREATE_TRIP'||kind==='CANCEL_TRIP'?'RIDER_INTAKE':'ASSIGNED_SERVICE_DELIVERY',branchScope:'branch:synthetic-all',fleetScope:'fleet:synthetic-all'});
}
function view(record:BrowserCommandRecord){return {id:record.id,envelope:record.envelope,result:record.result,expired:record.expired,acknowledged:record.acknowledged};}
export function createPostgresBrowserRecoveryService(pool:Pool,services:Services){
 const store=createBrowserCommandRecoveryStore(pool),context=(c:Context)=>({tenantId:c.organizationId,actorId:c.principal.id});
 const authorized=(c:Context,record:BrowserCommandRecord)=>{access(c,record.kind);return record;};
 async function executeOriginal(c:Context,id:string,envelope:BrowserCommandEnvelope){
  const base={organizationId:c.organizationId,principal:c.principal,key:`browser-command-${id}`};
  switch(envelope.kind){
   case 'CREATE_TRIP':return services.application.createTrip({...base,request:envelope.body});
   case 'CANCEL_TRIP':return services.application.cancelTrip({...base,tripId:envelope.resourceId,ifMatch:envelope.expectedTag,request:envelope.body});
   case 'ASSIGN_RUN':return services.dispatchService.assign({...base,runId:envelope.resourceId,ifMatch:envelope.expectedTag,request:envelope.body});
   case 'DECIDE_ROUTE':
    if(envelope.expectedTag!==services.application.etag(`${c.organizationId}:${envelope.resourceId}`,envelope.body.expectedRunVersion,'route-decision-v1'))throw new ProtocolError(412,'PRECONDITION_FAILED','proposal tag mismatch');
    return services.routeProposalService.decide({...base,proposalId:envelope.resourceId,request:envelope.body});
   case 'OVERRIDE_RETURN':return services.driverClosureService.override({...base,shiftId:envelope.resourceId,request:envelope.body});
  }
 }
 return {
  async pending(c:Context){
   // Check some material-command authority even when the slot is empty.
   if(!Object.keys(permissions).some(kind=>{try{access(c,kind as BrowserCommandEnvelope['kind']);return true;}catch{return false;}}))throw new ProtocolError(404,'RESOURCE_NOT_FOUND','recovery hidden');
   const record=await store.pending(context(c));return {command:record?view(authorized(c,record)):null};
  },
  async prepare(c:Context,input:Static<typeof BrowserCommandPrepareSchema>){access(c,input.envelope.kind);return view(await store.prepare(context(c),{id:input.id,kind:input.envelope.kind,envelope:input.envelope as JsonValue}));},
  async execute(c:Context,id:string){
   const record=authorized(c,await store.read(context(c),id));
   if(record.result!==null)return view(record);
   if(record.expired)throw new ProtocolError(410,'RECOVERY_EXPIRED_REVIEW_REQUIRED','original request requires review');
   let result:JsonValue;
   try{
    const receipt=await executeOriginal(c,id,record.envelope as BrowserCommandEnvelope);
    result={outcome:'ACCEPTED',statusCode:receipt.statusCode,body:receipt.body as JsonValue,etag:receipt.headers.etag??null};
   }catch(error){
    const mapped=mappedError(error);
    if(mapped.status>=500||[401,403,408,429].includes(mapped.status)||['PERSISTENCE_IDEMPOTENCY_IN_PROGRESS','PERSISTENCE_IDEMPOTENCY_EXPIRED'].includes(mapped.code))throw error;
    result={outcome:'REJECTED',statusCode:mapped.status,code:mapped.code};
   }
   // A crash here replays the same original domain idempotency key next time.
   return view(await store.settle(context(c),id,result));
  },
  async acknowledge(c:Context,id:string){authorized(c,await store.read(context(c),id));return view(await store.acknowledge(context(c),id));},
 };
}
export type BrowserRecoveryService=ReturnType<typeof createPostgresBrowserRecoveryService>;
