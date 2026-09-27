import {Type,type Static} from 'typebox';

export const DispatchTraceMapSchema=Type.Object({
  shiftReference:Type.String({format:'uuid'}),
  serviceDate:Type.String({format:'date',maxLength:10}),
  clientId:Type.Union([Type.String({format:'uuid'}),Type.Null()]),
  fixCount:Type.Integer({minimum:0,maximum:500}),
  mapImageUrl:Type.Union([Type.String({pattern:'^data:image/png;base64,[A-Za-z0-9+/=]+$',maxLength:1200025}),Type.Null()]),
},{additionalProperties:false,$id:'DispatchTraceMap'});
export type DispatchTraceMap=Static<typeof DispatchTraceMapSchema>;
export type DispatchTraceMapService=(input:{organizationId:string;serviceDate:string;shiftId:string;clientId:string|null;
  viewport?:{latitude:number;longitude:number;zoom:number}|null})=>Promise<DispatchTraceMap>;
