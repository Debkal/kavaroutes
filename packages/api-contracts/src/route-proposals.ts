import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {Type,type Static} from 'typebox';
import {createPostgresPersistence,createRouteProposalReader,PersistenceConflict,type TenantMutationTransaction} from '@kavaroutes/postgres-persistence';
import {RouteProposalConflict} from '@kavaroutes/platform-engine/domain';
import {authorize,companyBranchScope,companyFleetScope,type SyntheticPrincipal} from './security.js';
import {ProtocolError,requestFingerprint} from './protocol.js';

const id=()=>Type.String({format:'uuid'}),closed={additionalProperties:false};
export const RouteProposalRequestSchema=Type.Object({proposalId:id(),shiftGeneration:id(),policyDigest:Type.String({pattern:'^[a-f0-9]{64}$'}),expectedRunVersion:Type.Integer({minimum:1}),nodeOrder:Type.Array(id(),{minItems:2,maxItems:500,uniqueItems:true}),parkedAttestation:Type.Literal(true)},{...closed,$id:'RouteProposalRequest'});
export const RouteDecisionRequestSchema=Type.Object({decision:Type.Union([Type.Literal('APPROVED'),Type.Literal('REJECTED')]),expectedRunVersion:Type.Integer({minimum:1})},{...closed,$id:'RouteDecisionRequest'});
export const RouteProposalViewSchema=Type.Object({shiftId:id(),runId:id(),runVersion:Type.Integer({minimum:1}),factsVersion:Type.Integer({minimum:1}),shiftGeneration:id(),policyDigest:Type.String({pattern:'^[a-f0-9]{64}$'}),expectedTag:Type.String(),mode:Type.String({enum:['DISABLED','AUTHORIZED_SELF_APPROVE','DISPATCH_APPROVAL_REQUIRED']}),nodes:Type.Array(Type.Object({nodeId:id(),tripLegId:Type.Union([id(),Type.Null()]),kind:Type.String({enum:['PICKUP','DROPOFF','BREAK','RETURN']}),locked:Type.Boolean()},closed),{maxItems:500}),proposals:Type.Array(Type.Object({proposalId:id(),expectedTag:Type.String(),nodeOrder:Type.Array(id(),{maxItems:500}),runVersion:Type.Integer({minimum:1}),state:Type.String({enum:['PENDING_DISPATCH_APPROVAL','APPROVED','REJECTED','EXPIRED','CONFLICT']})},closed),{maxItems:100})},{...closed,$id:'RouteProposalView'});
export const RouteProposalReceiptSchema=Type.Object({proposalId:id(),runId:id(),runVersion:Type.Integer({minimum:1}),state:Type.Union([Type.Literal('PENDING_DISPATCH_APPROVAL'),Type.Literal('APPROVED'),Type.Literal('REJECTED'),Type.Literal('EXPIRED'),Type.Literal('CONFLICT')])},{...closed,$id:'RouteProposalReceipt'});
type Receipt=Static<typeof RouteProposalReceiptSchema>;
type SubmitRequest=Static<typeof RouteProposalRequestSchema>;
type DecisionRequest=Static<typeof RouteDecisionRequestSchema>;
const mapError=(error:unknown):never=>{
 if(error instanceof RouteProposalConflict)throw new ProtocolError(422,error.code,'route constraints failed');
 if(error && typeof error==='object' && 'code' in error && ['40001','40P01'].includes(String(error.code)))throw new PersistenceConflict('stale-version','route changed concurrently');
 throw error;
};
export function createPostgresRouteProposalService(pool:Pool){
 const persistence=createPostgresPersistence(pool);
 async function record(tx:TenantMutationTransaction,principal:SyntheticPrincipal,receipt:Receipt,fingerprint:string,version:number){
  await tx.appendAudit({auditId:randomUUID(),aggregateKind:'route-proposal',aggregateId:receipt.proposalId,aggregateVersion:version,actionReference:version===1?'driver.route.proposed':'dispatch.route.decided',actorReference:principal.id});
  const messageId=randomUUID(),now=new Date(),retainUntil=new Date(Date.now()+2_592_100_000);
  await tx.appendOutboxMessage({messageId,eventId:randomUUID(),aggregateType:'ROUTE_PROPOSAL',aggregateId:receipt.proposalId,aggregateVersion:version,eventType:'RouteProposalRecorded',schemaVersion:'v1',occurredAt:now,commandId:randomUUID(),idempotencyReferenceHash:fingerprint,correlationId:randomUUID(),source:'kavaroutes.api',classificationReference:'OPERATIONAL_SENSITIVE',purposeReference:'ASSIGNED_SERVICE_DELIVERY',policyReference:'privacy-synthetic-v1',payload:{runId:receipt.runId,runVersion:receipt.runVersion},retainUntil});
  await tx.appendOutboxDelivery({deliveryId:randomUUID(),messageId,route:'realtime-signal',jobType:'kr.realtime-signal.route-proposal.v1',availableAt:now,retainUntil});
  return {statusCode:200,body:receipt,headers:{},resultReference:receipt.proposalId};
 }
 return {
  async read(input:{organizationId:string;principal:SyntheticPrincipal;shiftId:string;dispatcher:boolean}){
   authorize(input.principal,input.organizationId,input.dispatcher?{capability:'dispatch:read',purpose:'ASSIGNED_SERVICE_DELIVERY',branchScope:companyBranchScope(input.organizationId),fleetScope:companyFleetScope(input.organizationId)}:{capability:'driver:manifest:read',purpose:'ASSIGNED_SERVICE_DELIVERY'});
   if(!input.dispatcher&&!input.principal.subjectId)throw new ProtocolError(404,'RESOURCE_NOT_FOUND','driver subject required');
   return createRouteProposalReader(pool)(input.organizationId,input.shiftId,input.dispatcher?undefined:input.principal.subjectId).catch(mapError);
  },
  async submit(input:{organizationId:string;principal:SyntheticPrincipal;shiftId:string;key:string;request:SubmitRequest}){
   authorize(input.principal,input.organizationId,{capability:'driver:execute',purpose:'ASSIGNED_SERVICE_DELIVERY'});
   if(!input.principal.subjectId)throw new ProtocolError(404,'RESOURCE_NOT_FOUND','driver subject required');
   const fingerprint=requestFingerprint({shiftId:input.shiftId,...input.request});
   return persistence.executeIdempotentMutation({tenantId:input.organizationId,actorReference:input.principal.id,operationId:'submitRouteProposal',key:input.key,fingerprint,recordId:randomUUID(),expiresAt:new Date(Date.now()+86_700_000),isolationLevel:'serializable'},async tx=>{
    const receipt=await tx.submitRouteProposal({proposalId:input.request.proposalId,shiftId:input.shiftId,driverId:input.principal.subjectId!,actorId:input.principal.id,shiftGeneration:input.request.shiftGeneration,policyDigest:input.request.policyDigest,expectedRunVersion:input.request.expectedRunVersion,order:input.request.nodeOrder,selfApproveCapability:input.principal.capabilities.has('driver-route:self-approve')});
    return record(tx,input.principal,receipt,fingerprint,1);
   }).catch(mapError);
  },
  async decide(input:{organizationId:string;principal:SyntheticPrincipal;proposalId:string;key:string;request:DecisionRequest}){
   authorize(input.principal,input.organizationId,{capability:'dispatch:command',purpose:'ASSIGNED_SERVICE_DELIVERY',branchScope:companyBranchScope(input.organizationId),fleetScope:companyFleetScope(input.organizationId)});
   const fingerprint=requestFingerprint({proposalId:input.proposalId,...input.request});
   return persistence.executeIdempotentMutation({tenantId:input.organizationId,actorReference:input.principal.id,operationId:'decideRouteProposal',key:input.key,fingerprint,recordId:randomUUID(),expiresAt:new Date(Date.now()+86_700_000),isolationLevel:'serializable'},async tx=>{
    const receipt=await tx.decideRouteProposal({proposalId:input.proposalId,actorId:input.principal.id,...input.request});
    return record(tx,input.principal,receipt,fingerprint,2);
   }).catch(mapError);
  },
 };
}
export type RouteProposalService=ReturnType<typeof createPostgresRouteProposalService>;
