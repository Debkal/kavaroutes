export type RoadGoal='LOW_COST'|'FASTEST'|'EASIEST';
export type RoadSelection={goal:RoadGoal|null;version:number;selectedAt:string|null};
export type RoadPreview={goal:RoadGoal;provider:'GOOGLE_ROUTES';distanceMeters:number;durationSeconds:number;
 tollEstimate:{currencyCode:string;amount:number}|null;tollsExpected:boolean;maneuverCount:number;pathFingerprint:string;
 steps:{instruction:string;maneuver:string;distanceMeters:number}[];mapImageDataUrl:string|null;googleMapsUrl:string;note:string};
const goals=new Set(['LOW_COST','FASTEST','EASIEST']);
const object=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('INVALID_ROAD_ROUTE');return value as Record<string,unknown>;};
const keys=(value:Record<string,unknown>,expected:string[])=>{if(Object.keys(value).sort().join(',')!==expected.sort().join(','))throw new Error('INVALID_ROAD_ROUTE');};
const goal=(value:unknown):RoadGoal=>{if(!goals.has(String(value)))throw new Error('INVALID_ROAD_ROUTE_GOAL');return value as RoadGoal;};
const integer=(value:unknown,min=0)=>{if(!Number.isSafeInteger(value)||Number(value)<min)throw new Error('INVALID_ROAD_ROUTE_NUMBER');return Number(value);};
export function decodeRoadSelection(value:unknown):RoadSelection{
 const row=object(value);keys(row,['goal','version','selectedAt']);
 if(row.selectedAt!==null&&(typeof row.selectedAt!=='string'||!Number.isFinite(Date.parse(row.selectedAt))))throw new Error('INVALID_ROAD_ROUTE_TIME');
 const selectedGoal=row.goal===null?null:goal(row.goal);
 if((selectedGoal===null)!==(row.selectedAt===null))throw new Error('INVALID_ROAD_ROUTE_SELECTION');
 return {goal:selectedGoal,version:integer(row.version),selectedAt:row.selectedAt as string|null};
}
export function decodeRoadPreview(value:unknown,expectedGoal:RoadGoal):RoadPreview{
 const row=object(value);keys(row,['goal','provider','distanceMeters','durationSeconds','tollEstimate','tollsExpected','maneuverCount','pathFingerprint','steps','mapImageDataUrl','googleMapsUrl','note']);
 if(goal(row.goal)!==expectedGoal||row.provider!=='GOOGLE_ROUTES'||typeof row.tollsExpected!=='boolean'||typeof row.pathFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(row.pathFingerprint))throw new Error('INVALID_ROAD_ROUTE');
 const toll=row.tollEstimate===null?null:object(row.tollEstimate);
 if(toll){keys(toll,['currencyCode','amount']);if(typeof toll.currencyCode!=='string'||!/^[A-Z]{3}$/.test(toll.currencyCode)||typeof toll.amount!=='number'||!Number.isFinite(toll.amount)||toll.amount<0)throw new Error('INVALID_ROAD_ROUTE_TOLL');}
 if(!Array.isArray(row.steps)||row.steps.length>300)throw new Error('INVALID_ROAD_ROUTE_STEPS');
 const steps=row.steps.map(raw=>{const step=object(raw);keys(step,['instruction','maneuver','distanceMeters']);if(typeof step.instruction!=='string'||!step.instruction.length||step.instruction.length>500||typeof step.maneuver!=='string'||step.maneuver.length>60)throw new Error('INVALID_ROAD_ROUTE_STEP');return {instruction:step.instruction,maneuver:step.maneuver,distanceMeters:integer(step.distanceMeters)};});
 if(row.mapImageDataUrl!==null&&(typeof row.mapImageDataUrl!=='string'||!/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(row.mapImageDataUrl)||row.mapImageDataUrl.length>700000))throw new Error('INVALID_ROAD_ROUTE_MAP');
 if(typeof row.googleMapsUrl!=='string'||!row.googleMapsUrl.startsWith('https://www.google.com/maps/dir/?api=1&')||row.googleMapsUrl.length>2048||typeof row.note!=='string'||row.note.length>300)throw new Error('INVALID_ROAD_ROUTE_LINK');
 return {goal:expectedGoal,provider:'GOOGLE_ROUTES',distanceMeters:integer(row.distanceMeters,1),durationSeconds:integer(row.durationSeconds,1),
  tollEstimate:toll as RoadPreview['tollEstimate'],tollsExpected:row.tollsExpected,maneuverCount:integer(row.maneuverCount),pathFingerprint:row.pathFingerprint,
  steps,mapImageDataUrl:row.mapImageDataUrl as string|null,googleMapsUrl:row.googleMapsUrl,note:row.note};
}
export function decodeDriverRoadRoute(value:unknown){
 const row=object(value);keys(row,['selection','route']);const selection=decodeRoadSelection(row.selection);
 if(selection.goal===null&&row.route!==null)throw new Error('INVALID_DRIVER_ROAD_ROUTE');
 const route=selection.goal===null?null:decodeRoadPreview(row.route,selection.goal);
 return {selection,route};
}
