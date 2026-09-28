import {Type,type Static} from 'typebox';

const Name=Type.String({minLength:1,maxLength:64,pattern:'^[A-Z][A-Z0-9_]*$'});
export const ProviderUsageSchema=Type.Object({
  hours:Type.Union([Type.Literal(1),Type.Literal(24),Type.Literal(168)]),
  total:Type.Integer({minimum:0}),averageRequestsPerHour:Type.Number({minimum:0}),averageMs:Type.Integer({minimum:0}),
  groups:Type.Array(Type.Object({provider:Name,operation:Name,feature:Name,count:Type.Integer({minimum:0}),
    failed:Type.Integer({minimum:0}),averageMs:Type.Integer({minimum:0})},{additionalProperties:false}),{maxItems:500}),
  recent:Type.Array(Type.Object({at:Type.String({format:'date-time'}),provider:Name,operation:Name,feature:Name,
    status:Type.Integer({minimum:0,maximum:599}),durationMs:Type.Integer({minimum:0,maximum:60000})},{additionalProperties:false}),{maxItems:100}),
  pendingCount:Type.Integer({minimum:0}),droppedCount:Type.Integer({minimum:0}),
  lastFailureAt:Type.Union([Type.String({format:'date-time'}),Type.Null()]),
},{additionalProperties:false,$id:'ProviderUsage'});
export type ProviderUsage=Static<typeof ProviderUsageSchema>;
export type ProviderUsageService=(organizationId:string,hours:1|24|168)=>Promise<ProviderUsage>;
