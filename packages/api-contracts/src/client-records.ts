import {randomUUID} from "node:crypto";
import type {Pool} from "pg";
import {Type,type Static} from "typebox";
import {createClientRosterReader,createPostgresPersistence} from "@kavaroutes/postgres-persistence";
import {authorize,companyBranchScope,companyFleetScope,type SyntheticPrincipal} from "./security.js";
import {requestFingerprint} from "./protocol.js";

const id=()=>Type.String({format:"uuid"});
const bounded=(max:number)=>Type.String({minLength:1,maxLength:max});
const optionalNull=(schema:ReturnType<typeof Type.String>)=>Type.Optional(Type.Union([schema,Type.Null()]));

/**
 * Dispatch-authored client intake. One command creates the client and the trip pattern
 * it books: a pickup address, one or more drop-off addresses and whether the trip
 * returns. The addresses are stored as intake.address rows; the drop-offs are ordered
 * intake.client_dropoff rows, so a plan turns each one into a leg without parsing text.
 */
export const ClientCreateRequestSchema=Type.Object({
 displayName:bounded(200),
 entityName:optionalNull(bounded(200)),
 phone:optionalNull(Type.String({minLength:3,maxLength:40})),
 pickupAddress:optionalNull(bounded(512)),
 dropoffAddresses:Type.Optional(Type.Array(bounded(512),{minItems:1,maxItems:20})),
 tripType:Type.Optional(Type.Union([Type.Literal("ONE_WAY"),Type.Literal("ROUND_TRIP")])),
 notes:optionalNull(bounded(2000)),
},{additionalProperties:false,$id:"ClientCreateRequest"});
export type ClientCreateRequest=Static<typeof ClientCreateRequestSchema>;
export const ClientUpdateRequestSchema=Type.Object({
 displayName:bounded(200),
 entityName:optionalNull(bounded(200)),
 phone:optionalNull(Type.String({minLength:3,maxLength:40})),
 pickupAddress:optionalNull(bounded(512)),
 tripType:Type.Optional(Type.Union([Type.Literal("ONE_WAY"),Type.Literal("ROUND_TRIP")])),
 notes:optionalNull(bounded(2000)),
 /** Drop-offs appended after the ones already recorded. */
 addDropoffAddresses:Type.Optional(Type.Array(bounded(512),{minItems:1,maxItems:20})),
},{additionalProperties:false,$id:"ClientUpdateRequest"});
export type ClientUpdateRequest=Static<typeof ClientUpdateRequestSchema>;
export const ClientCreateReceiptSchema=Type.Object({clientId:id(),version:Type.Integer({minimum:1}),displayName:bounded(200),dropoffCount:Type.Integer({minimum:0,maximum:20})},{additionalProperties:false,$id:"ClientCreateReceipt"});
export type ClientCreateReceipt=Static<typeof ClientCreateReceiptSchema>;
const ClientDropoffSchema=Type.Object({ordinal:Type.Integer({minimum:1,maximum:20}),addressLabel:bounded(512)},{additionalProperties:false});
const ClientRouteSchema=Type.Object({tripId:id(),serviceDate:Type.String({format:"date"})},{additionalProperties:false});
export const ClientRosterSchema=Type.Object({
 clients:Type.Array(Type.Object({clientId:id(),displayName:bounded(200),entityName:Type.Union([bounded(200),Type.Null()]),
  phone:Type.Union([Type.String({minLength:3,maxLength:40}),Type.Null()]),pickupAddress:Type.Union([bounded(512),Type.Null()]),
  dropoffAddresses:Type.Array(ClientDropoffSchema,{maxItems:20}),
  tripType:Type.Union([Type.Literal("ONE_WAY"),Type.Literal("ROUND_TRIP"),Type.Null()]),
  notes:Type.Union([bounded(2000),Type.Null()]),version:Type.Integer({minimum:1}),routes:Type.Array(ClientRouteSchema,{maxItems:25})},{additionalProperties:false}),{maxItems:200}),
 nextAfter:Type.Union([id(),Type.Null()]),
},{additionalProperties:false,$id:"ClientRoster"});
export type ClientRoster=Static<typeof ClientRosterSchema>;

/** Declared here so the public service type never names a persistence type. */
export interface ClientReceipt {readonly clientId:string;readonly version:number;readonly displayName:string;readonly dropoffCount:number;}

export function createPostgresClientService(pool:Pool){
 const persistence=createPostgresPersistence(pool),roster=createClientRosterReader(pool);
 const access=(organizationId:string,principal:SyntheticPrincipal,command:boolean)=>authorize(principal,organizationId,
  {capability:command?"dispatch:command":"dispatch:read",purpose:"ASSIGNED_SERVICE_DELIVERY",branchScope:companyBranchScope(organizationId),fleetScope:companyFleetScope(organizationId)});
 return {
  async create(input:{organizationId:string;principal:SyntheticPrincipal;key:string;request:ClientCreateRequest}){
   access(input.organizationId,input.principal,true);
   const fingerprint=requestFingerprint({kind:"createClient",...input.request});
   return persistence.executeIdempotentMutation<ClientReceipt>({tenantId:input.organizationId,actorReference:input.principal.id,operationId:"createClient",key:input.key,fingerprint,recordId:randomUUID(),expiresAt:new Date(Date.now()+86_700_000),isolationLevel:"serializable"},async tx=>{
    const created=await tx.createClientRecord({displayName:input.request.displayName,entityName:input.request.entityName??null,
     phone:input.request.phone??null,pickupAddress:input.request.pickupAddress??null,
     dropoffAddresses:input.request.dropoffAddresses??[],tripType:input.request.tripType??null,notes:input.request.notes??null});
    const receipt:ClientReceipt={clientId:created.clientId,version:created.version,displayName:input.request.displayName,dropoffCount:created.dropoffCount};
    await tx.appendAudit({auditId:randomUUID(),aggregateKind:"client",aggregateId:receipt.clientId,aggregateVersion:receipt.version,
     actionReference:"client.intake.created",actorReference:input.principal.id});
    return {statusCode:201,body:receipt,headers:{},resultReference:receipt.clientId};
   });
  },

  /** Correct a client record. Operator fields and the pickup label are replaced; new
   * drop-offs are appended, because the pattern history stays append-only. */
  async update(input:{organizationId:string;principal:SyntheticPrincipal;clientId:string;key:string;request:ClientUpdateRequest}){
   access(input.organizationId,input.principal,true);
   const fingerprint=requestFingerprint({kind:"updateClient",clientId:input.clientId,...input.request});
   return persistence.executeIdempotentMutation<ClientReceipt>({tenantId:input.organizationId,actorReference:input.principal.id,operationId:"updateClient",key:input.key,fingerprint,recordId:randomUUID(),expiresAt:new Date(Date.now()+86_700_000),isolationLevel:"serializable"},async tx=>{
    const updated=await tx.updateClientRecord({clientId:input.clientId,displayName:input.request.displayName,entityName:input.request.entityName??null,
     phone:input.request.phone??null,pickupAddress:input.request.pickupAddress??null,tripType:input.request.tripType??null,notes:input.request.notes??null,
     addDropoffAddresses:input.request.addDropoffAddresses??[]});
    const receipt:ClientReceipt={clientId:updated.clientId,version:updated.version,displayName:input.request.displayName,dropoffCount:updated.dropoffCount};
    await tx.appendAudit({auditId:randomUUID(),aggregateKind:"client",aggregateId:receipt.clientId,aggregateVersion:receipt.version,
     actionReference:"client.intake.updated",actorReference:input.principal.id});
    return {statusCode:200,body:receipt,headers:{},resultReference:receipt.clientId};
   });
  },
  async read(organizationId:string,principal:SyntheticPrincipal,input:{clientId?:string;after?:string;limit:number}){
   access(organizationId,principal,false);
   const page=await roster({tenantId:organizationId,limit:input.limit,...(input.clientId?{clientId:input.clientId}:{}),...(input.after?{after:input.after}:{})});
   return {clients:page.items,nextAfter:page.nextAfter};
  },
 };
}
export type ClientService=ReturnType<typeof createPostgresClientService>;
