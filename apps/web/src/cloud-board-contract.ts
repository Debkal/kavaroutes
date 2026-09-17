// Client-only closed decoder; no persistence/server imports or browser storage.
type Row=Record<string,unknown>;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function object(value:unknown,keys:string[]):Row{
 if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).sort().join(',')!==[...keys].sort().join(','))throw new Error('INVALID_BOARD_RESPONSE');
 return value as Row;
}
function text(v:unknown){if(typeof v!=='string'||!v.length||v.length>512)throw new Error('INVALID_BOARD_TEXT');return v;}
function id(v:unknown){const s=text(v);if(!uuid.test(s))throw new Error('INVALID_BOARD_ID');return s;}
function nullableId(v:unknown){return v===null?null:id(v);}
function integer(v:unknown,min=1){if(!Number.isSafeInteger(v)||Number(v)<min)throw new Error('INVALID_BOARD_VERSION');return Number(v);}
function instant(v:unknown){const s=text(v);if(!/^\d{4}-\d{2}-\d{2}T/.test(s)||!Number.isFinite(Date.parse(s)))throw new Error('INVALID_BOARD_TIME');return s;}
function list<T>(v:unknown,max:number,decode:(v:unknown)=>T){if(!Array.isArray(v)||v.length>max)throw new Error('INVALID_BOARD_LIST');return v.map(decode);}
function tag(v:unknown){const s=text(v);if(!/^"kr1\.[A-Za-z0-9_-]{43}"$/.test(s))throw new Error('INVALID_BOARD_TAG');return s;}
export function decodeCloudBoard(value:unknown,serviceDate:string){
 const b=object(value,['serviceDate','runs','legs','drivers','vehicles']);if(b.serviceDate!==serviceDate)throw new Error('BOARD_DATE_MISMATCH');
 const runs=list(b.runs,500,v=>{const r=object(v,['runId','version','expectedTag','lifecycle','plannedStartAt','plannedEndAt','serviceTimezone','assignmentId','driverId','vehicleId']);return {runId:id(r.runId),version:integer(r.version),expectedTag:tag(r.expectedTag),lifecycle:text(r.lifecycle),plannedStartAt:instant(r.plannedStartAt),plannedEndAt:instant(r.plannedEndAt),serviceTimezone:text(r.serviceTimezone),assignmentId:nullableId(r.assignmentId),driverId:nullableId(r.driverId),vehicleId:nullableId(r.vehicleId)};});
 const legs=list(b.legs,2000,v=>{const l=object(v,['runId','tripLegId','tripId','ordinal','riderLabel','pickupLabel','dropoffLabel','plannedStartAt','plannedEndAt','tripState','executionId','lifecycle','version']);return {runId:id(l.runId),tripLegId:id(l.tripLegId),tripId:id(l.tripId),ordinal:integer(l.ordinal),riderLabel:text(l.riderLabel),pickupLabel:text(l.pickupLabel),dropoffLabel:text(l.dropoffLabel),plannedStartAt:instant(l.plannedStartAt),plannedEndAt:instant(l.plannedEndAt),tripState:text(l.tripState),executionId:nullableId(l.executionId),lifecycle:text(l.lifecycle),version:integer(l.version,0)};});
 const resource=(v:unknown)=>{const r=object(v,['id','label']);return {id:id(r.id),label:text(r.label)};};
 if(new Set(runs.map(r=>r.runId)).size!==runs.length || new Set(legs.map(l=>`${l.runId}:${l.tripLegId}`)).size!==legs.length || legs.some(l=>!runs.some(r=>r.runId===l.runId)))throw new Error('BOARD_AMBIGUITY');
 return {serviceDate,runs,legs,drivers:list(b.drivers,500,resource),vehicles:list(b.vehicles,500,resource)};
}
export type CloudBoard=ReturnType<typeof decodeCloudBoard>;
export type CloudAssignmentCommand={runId:string;expectedVersion:number;expectedTag:string;driverId:string;vehicleId:string;key:string};
export function decodeCloudAssignment(value:unknown,command:CloudAssignmentCommand){
 const hasPrior=!!value && typeof value==='object' && 'supersedes' in value;
 const r=object(value,['assignmentId','runId','version','serviceDate',...(hasPrior?['supersedes']:[])]);
 if(r.runId!==command.runId || r.version!==command.expectedVersion+1 || !/^\d{4}-\d{2}-\d{2}$/.test(text(r.serviceDate)))throw new Error('ASSIGNMENT_RECEIPT_MISMATCH');
 if(hasPrior)id(r.supersedes);
 return {assignmentId:id(r.assignmentId),runId:id(r.runId),version:integer(r.version),serviceDate:text(r.serviceDate)};
}

export type CloudPlanLeg={
 riderReference:string;pickupLabel:string;dropoffLabel:string;localServiceTime:string;
 resolvedServiceAt:string;resolvedUtcOffsetSeconds:number;plannedStartAt:string;plannedEndAt:string;
 pickupRequired:boolean;dropoffRequired:boolean;mobilitySecurementRequired:boolean;
};
export type CloudPlanRequest={
 serviceDate:string;serviceTimezone:string;plannedStartAt:string;plannedEndAt:string;
 seatsRequired?:number;wheelchairSpacesRequired?:number;legs:CloudPlanLeg[];
 /** The client record this run is entered for. Omitted when dispatch plans a run
  * with no client, which stays the pre-client behaviour. */
 clientId?:string;
};
/** A planned-run receipt is only accepted when it describes the run that was asked for. */
export function decodeCloudPlanReceipt(value:unknown,request:CloudPlanRequest){
 const r=object(value,['runId','version','serviceDate','legCount','tripLegIds']);
 if(r.serviceDate!==request.serviceDate || r.legCount!==request.legs.length)throw new Error('PLAN_RECEIPT_MISMATCH');
 const tripLegIds=list(r.tripLegIds,25,id);
 if(tripLegIds.length!==request.legs.length || new Set(tripLegIds).size!==tripLegIds.length)throw new Error('PLAN_RECEIPT_MISMATCH');
 return {runId:id(r.runId),version:integer(r.version),serviceDate:text(r.serviceDate),legCount:integer(r.legCount),tripLegIds};
}

/** The one-time invite for a driver login. The code is returned exactly once, by the
 * command that creates it, and never again by any read. */
export function decodeCloudDriverLogin(value:unknown){
 const r=object(value,['driverId','loginId','inviteCode','status','version']);
 if(r.status!=='INVITED')throw new Error('INVALID_DRIVER_LOGIN_RECEIPT');
 const loginId=text(r.loginId);
 if(!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(loginId))throw new Error('INVALID_DRIVER_LOGIN_RECEIPT');
 const code=text(r.inviteCode);
 if(code.length<8||code.length>64)throw new Error('INVALID_DRIVER_LOGIN_RECEIPT');
 return {driverId:id(r.driverId),loginId,inviteCode:code,status:'INVITED' as const,version:integer(r.version)};
}

/** A released run receipt: the run it names, one version past the one we held, and the
 * assignment that was removed. Nothing else is accepted. */
export function decodeCloudRelease(value:unknown,request:{runId:string;expectedVersion:number;serviceDate:string}){
 const r=object(value,['runId','version','serviceDate','releasedAssignmentId']);
 if(id(r.runId)!==request.runId||r.serviceDate!==request.serviceDate)throw new Error('RELEASE_RECEIPT_MISMATCH');
 if(integer(r.version)!==request.expectedVersion+1)throw new Error('RELEASE_RECEIPT_MISMATCH');
 return {runId:request.runId,version:integer(r.version),serviceDate:text(r.serviceDate),releasedAssignmentId:id(r.releasedAssignmentId)};
}
