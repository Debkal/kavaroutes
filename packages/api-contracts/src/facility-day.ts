import type {Pool} from 'pg';
import {Type} from 'typebox';
import {createFacilityDayReader} from '@kavaroutes/postgres-persistence';
import {authorize,type SyntheticPrincipal} from './security.js';
import {ProtocolError} from './protocol.js';
export const FacilityDaySchema=Type.Object({facilityReference:Type.String({format:'uuid'}),serviceDate:Type.String({format:'date'}),items:Type.Array(Type.Ref('FacilityTripProjection'),{maxItems:100}),nextAfter:Type.Union([Type.String({format:'uuid'}),Type.Null()])},{additionalProperties:false,$id:'FacilityDay'});
export function createPostgresFacilityService(pool:Pool){
 const read=createFacilityDayReader(pool);
 const identity=(principal:SyntheticPrincipal,organizationId:string)=>{
  authorize(principal,organizationId,{capability:'facility:trip-status:read',purpose:'FACILITY_COORDINATION'});
  if(!principal.subjectId)throw new ProtocolError(404,'RESOURCE_NOT_FOUND','facility required');return principal.subjectId;
 };
 return {
  async day(input:{principal:SyntheticPrincipal;organizationId:string;serviceDate:string;after?:string;limit:number}){
   const facilityId=identity(input.principal,input.organizationId);
   const page=await read({tenantId:input.organizationId,facilityId,serviceDate:input.serviceDate,limit:input.limit,...(input.after?{after:input.after}:{})});
   return {facilityReference:facilityId,serviceDate:input.serviceDate,...page};
  },
  async trip(input:{principal:SyntheticPrincipal;organizationId:string;tripId:string}){
   const facilityId=identity(input.principal,input.organizationId);
   const page=await read({tenantId:input.organizationId,facilityId,tripId:input.tripId,limit:1});
   if(!page.items[0])throw new ProtocolError(404,'RESOURCE_NOT_FOUND','trip hidden');return page.items[0];
  }
 };
}
export type FacilityService=ReturnType<typeof createPostgresFacilityService>;
