import {Type,type Static} from 'typebox';

const id=()=>Type.String({format:'uuid'});
const instant=()=>Type.String({format:'date-time',maxLength:35});
export const DispatchRouteHistoryEventSchema=Type.Object({
  shiftReference:id(),runId:id(),tripLegId:Type.Union([id(),Type.Null()]),
  kind:Type.Union([Type.Literal('SHIFT_STARTED'),Type.Literal('DRIVER_ACTION'),Type.Literal('SERVICE_PROOF'),Type.Literal('TRACKING_ALERT'),Type.Literal('SHIFT_CLOSURE')]),
  action:Type.String({minLength:1,maxLength:80}),outcome:Type.Union([Type.String({maxLength:80}),Type.Null()]),
  reason:Type.Union([Type.String({maxLength:96}),Type.Null()]),occurredAt:instant(),recordedAt:instant(),
},{additionalProperties:false,$id:'DispatchRouteHistoryEvent'});
export const DispatchRouteHistorySchema=Type.Object({
  serviceDate:Type.String({format:'date',maxLength:10}),truncated:Type.Boolean(),
  events:Type.Array(Type.Ref('DispatchRouteHistoryEvent'),{maxItems:3000}),
  tripClients:Type.Array(Type.Object({tripId:id(),clientId:id(),clientLabel:Type.String({minLength:1,maxLength:200})},{additionalProperties:false}),{maxItems:2000}),
},{additionalProperties:false,$id:'DispatchRouteHistory'});
export type DispatchRouteHistory=Static<typeof DispatchRouteHistorySchema>;
export type DispatchRouteHistoryReader=(organizationId:string,serviceDate:string)=>Promise<DispatchRouteHistory>;
