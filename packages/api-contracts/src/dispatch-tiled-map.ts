import {Type,type Static} from 'typebox';

const Coordinate=Type.Tuple([Type.Number({minimum:-85,maximum:85}),Type.Number({minimum:-180,maximum:180})]);
export const DispatchFullTraceSchema=Type.Object({
  shiftReference:Type.String({format:'uuid'}),serviceDate:Type.String({format:'date',maxLength:10}),
  clientId:Type.Union([Type.String({format:'uuid'}),Type.Null()]),
  truncated:Type.Boolean(),fixCount:Type.Integer({minimum:0,maximum:100000}),
  points:Type.Array(Type.Object({latitude:Type.Number({minimum:-85,maximum:85}),longitude:Type.Number({minimum:-180,maximum:180}),
    accuracyMeters:Type.Union([Type.Number({minimum:0}),Type.Null()]),capturedAt:Type.String({format:'date-time'}),window:Type.Integer({minimum:0})},{additionalProperties:false}),{maxItems:100000}),
},{additionalProperties:false,$id:'DispatchFullTrace'});
export const DispatchMapMatchSchema=Type.Object({status:Type.Union([Type.Literal('PENDING'),Type.Literal('READY'),Type.Literal('PARTIAL'),Type.Literal('UNAVAILABLE')]),
  segments:Type.Array(Type.Array(Coordinate,{minItems:2}),{maxItems:1000}),
  windows:Type.Array(Type.Integer({minimum:0}),{maxItems:1000})},{additionalProperties:false,$id:'DispatchMapMatch'});
export const DispatchMapTileSchema=Type.Object({imageUrl:Type.String({pattern:'^data:image/png;base64,[A-Za-z0-9+/=]+$',maxLength:400025})},
  {additionalProperties:false,$id:'DispatchMapTile'});
export const DispatchMapTileBatchSchema=Type.Object({tiles:Type.Array(Type.Object({
  z:Type.Integer({minimum:4,maximum:19}),x:Type.Integer({minimum:0}),y:Type.Integer({minimum:0}),
  imageUrl:Type.Union([Type.String({pattern:'^data:image/png;base64,[A-Za-z0-9+/=]+$',maxLength:400025}),Type.Null()]),
},{additionalProperties:false}),{minItems:1,maxItems:32})},{additionalProperties:false,$id:'DispatchMapTileBatch'});
export type DispatchFullTrace=Static<typeof DispatchFullTraceSchema>;
export type DispatchMapMatch=Static<typeof DispatchMapMatchSchema>;
export type DispatchMapTile=Static<typeof DispatchMapTileSchema>;
export type DispatchMapTileBatch=Static<typeof DispatchMapTileBatchSchema>;
export type DispatchFullTraceReader=(input:{organizationId:string;serviceDate:string;shiftId:string;clientId:string|null})=>Promise<DispatchFullTrace>;
export type DispatchMapMatchService=(input:{organizationId:string;serviceDate:string;shiftId:string;clientId:string|null})=>Promise<DispatchMapMatch>;
export type DispatchMapTileService=(input:{z:number;x:number;y:number})=>Promise<DispatchMapTile>;
export type DispatchMapTileBatchService=(input:{tiles:{z:number;x:number;y:number}[]})=>Promise<DispatchMapTileBatch>;
